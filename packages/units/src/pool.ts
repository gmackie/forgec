// Instances of a WASM unit for concurrent calls (FORG-41). jco serializes calls on one component
// instance: a JSPI-lifted export takes the instance's exclusive lock, so while one call is
// suspended on a capability read, the next call on the same instance waits. The harness gives each
// in-flight call its own instance instead, reusing idle ones (research/composable-units/r3-wasm-pool).
//
// A call that throws (a trap, a host defect, a lowering mismatch) discards its instance: it is
// never handed to another call, whatever state the trap left in its linear memory or in jco's task
// bookkeeping. A declared failure is a normal return, so its instance goes back to the pool.
//
// No Node or platform imports: this module runs inside the Worker, next to the glue.

export interface PoolOptions {
  /** Most instances alive at once (busy + idle). A call beyond it waits for one to be released. */
  max: number;
  /** Most idle instances kept for reuse. Releasing beyond it drops the instance. */
  idle: number;
}

export interface PoolStats {
  /** Instances alive now, busy or idle. */
  live: number;
  idle: number;
  /** Calls waiting for an instance (only when `max` is reached). */
  waiting: number;
  /** Instances created since the pool was made. */
  created: number;
  /** Instances dropped because their call threw. */
  discarded: number;
  /** Most instances alive at once. */
  peak: number;
}

export interface InstancePool<T> {
  /** Runs `f` on an instance of its own. If `f` throws, the instance is discarded. */
  run<R>(f: (instance: T) => R | Promise<R>): Promise<R>;
  /** Creates one instance if none is alive, so a binding failure surfaces before the first call. */
  warm(): Promise<void>;
  stats(): PoolStats;
}

/**
 * The harness default (research/composable-units/r3-wasm-pool): up to 32 instances, an instance
 * per in-flight call, and every idle one kept for reuse (most recently released first). Keeping
 * fewer idle than the peak concurrency re-instantiates on every burst, which measured far slower
 * than waiting; the bound caps linear memory (about 1.1 MiB per PriceCart instance) at high
 * concurrency, where calls beyond 32 wait for a free instance instead of serializing on one.
 */
export const DEFAULT_POOL: PoolOptions = { max: 32, idle: 32 };

export function instancePool<T>(create: () => Promise<T>, options: PoolOptions = DEFAULT_POOL): InstancePool<T> {
  const { max, idle } = options;
  if (!(max >= 1)) throw new RangeError(`pool max must be at least 1, not ${max}`);
  if (!(idle >= 0)) throw new RangeError(`pool idle must be at least 0, not ${idle}`);
  const free: T[] = [];
  const waiters: Array<{ resolve: (t: T) => void; reject: (e: unknown) => void }> = [];
  let live = 0;
  let created = 0;
  let discarded = 0;
  let peak = 0;

  const spawn = async (): Promise<T> => {
    live++;
    peak = Math.max(peak, live);
    try {
      const t = await create();
      created++;
      return t;
    } catch (e) {
      live--;
      throw e;
    }
  };
  const acquire = (): Promise<T> => {
    if (free.length) return Promise.resolve(free.pop()!);
    if (live < max) return spawn();
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const release = (t: T) => {
    const w = waiters.shift();
    if (w) w.resolve(t);
    else if (free.length < idle) free.push(t);
    else live--;
  };
  const discard = () => {
    live--;
    discarded++;
    // The slot is free again: a waiting call gets a fresh instance, never the discarded one.
    const w = waiters.shift();
    if (w) spawn().then(w.resolve, w.reject);
  };

  return {
    async run(f) {
      const t = await acquire();
      let r;
      try {
        r = await f(t);
      } catch (e) {
        discard();
        throw e;
      }
      release(t);
      return r;
    },
    async warm() {
      if (live === 0) release(await spawn());
    },
    stats: () => ({ live, idle: free.length, waiting: waiters.length, created, discarded, peak }),
  };
}
