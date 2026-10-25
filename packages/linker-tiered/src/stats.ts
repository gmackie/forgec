// Linker C's tier stats (FORG-47). Deployed, the router's in-memory counters were per isolate, so
// `GET /_forge/tiered/stats` answered whichever isolate it reached, and `since` read 1970 because it
// was taken at module scope, where the Workers clock reads 0 (research/composable-units/r4-deployed).
//
// Now every router and tier-host isolate counts locally and reports its delta to one Durable Object
// (`TierStats` in the tier host script, binding FORGE_TIER_STATS, object "tier"):
//   - No request waits on the DO. An isolate flushes at most once per `flushMs`
//     (TIER_STATS_FLUSH_MS, default 1000) from `ctx.waitUntil`, after the answer is sent. A fallback
//     or an error is flushed at once (still in waitUntil): those are the counts that must not hide.
//   - The shared counts therefore lag by at most `flushMs` per isolate. A stats read flushes its own
//     isolate first.
//   - `since` is the DO's clock when the counts were created or reset: a real time.
//   - A failed flush keeps the delta and retries with the next one; it is logged, never dropped. With
//     no FORGE_TIER_STATS binding (a link from before FORG-47) the counts stay per isolate and the
//     answer says `scope: "isolate"`.
// Every fallback is also logged (`linker-tiered: FALLBACK ...`) by the code that counts it.
// Pure: no `cloudflare:workers`, so the router bundles it and Node tests it.

export const STATS_BINDING = "FORGE_TIER_STATS";
export const STATS_OBJECT = "tier";
export const DEFAULT_FLUSH_MS = 1000;
const RECENT = 50;
const ISOLATES = 100;

export interface Recent {
  at: string;
  entry: string;
  reason: string;
}
export interface WorkflowFallback {
  at: string;
  className: string;
  reason: string;
  detail: string;
}

/** What one isolate reports. */
export interface StatsDelta {
  isolate: string;
  kind: "router" | "tier";
  dynamic: number;
  packed: number;
  fallback: number;
  errors: number;
  byReason: Record<string, number>;
  byEntryPoint: Record<string, number>;
  recent: Recent[];
  workflowAdvances: { dynamic: number; fallback: number };
  workflowFallbacks: WorkflowFallback[];
}

export interface TierStatsState {
  scope: "shared" | "isolate";
  since: string;
  updatedAt: string | null;
  dynamic: number;
  packed: number;
  fallback: number;
  errors: number;
  byReason: Record<string, number>;
  byEntryPoint: Record<string, number>;
  recent: Recent[];
  workflowAdvances: { dynamic: number; fallback: number };
  workflowFallbacks: WorkflowFallback[];
  flushes: number;
  /** Isolates that reported, with their totals: shows the counts come from more than one. */
  isolates: Record<string, { kind: string; flushes: number; requests: number; lastAt: string }>;
}

export const emptyDelta = (isolate: string, kind: StatsDelta["kind"]): StatsDelta => ({ isolate, kind, dynamic: 0, packed: 0, fallback: 0, errors: 0, byReason: {}, byEntryPoint: {}, recent: [], workflowAdvances: { dynamic: 0, fallback: 0 }, workflowFallbacks: [] });

export const emptyState = (now: number, scope: TierStatsState["scope"] = "shared"): TierStatsState => ({ scope, since: new Date(now).toISOString(), updatedAt: null, dynamic: 0, packed: 0, fallback: 0, errors: 0, byReason: {}, byEntryPoint: {}, recent: [], workflowAdvances: { dynamic: 0, fallback: 0 }, workflowFallbacks: [], flushes: 0, isolates: {} });

const addCounts = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

/** Folds a delta into a delta (a failed flush's delta back into the pending one). */
export function mergeDelta(into: StatsDelta, d: StatsDelta): StatsDelta {
  into.dynamic += d.dynamic;
  into.packed += d.packed;
  into.fallback += d.fallback;
  into.errors += d.errors;
  addCounts(into.byReason, d.byReason);
  addCounts(into.byEntryPoint, d.byEntryPoint);
  into.recent = [...d.recent, ...into.recent].slice(-RECENT);
  into.workflowAdvances.dynamic += d.workflowAdvances.dynamic;
  into.workflowAdvances.fallback += d.workflowAdvances.fallback;
  into.workflowFallbacks = [...d.workflowFallbacks, ...into.workflowFallbacks].slice(-RECENT);
  return into;
}

/** Folds a delta into the totals (the DO, or one isolate's own totals). */
export function applyDelta(s: TierStatsState, d: StatsDelta, now: number): TierStatsState {
  s.dynamic += d.dynamic;
  s.packed += d.packed;
  s.fallback += d.fallback;
  s.errors += d.errors;
  addCounts(s.byReason, d.byReason);
  addCounts(s.byEntryPoint, d.byEntryPoint);
  s.recent = [...s.recent, ...d.recent].slice(-RECENT);
  s.workflowAdvances.dynamic += d.workflowAdvances.dynamic;
  s.workflowAdvances.fallback += d.workflowAdvances.fallback;
  s.workflowFallbacks = [...s.workflowFallbacks, ...d.workflowFallbacks].slice(-RECENT);
  s.flushes++;
  s.updatedAt = new Date(now).toISOString();
  const prev = s.isolates[d.isolate];
  s.isolates[d.isolate] = { kind: d.kind, flushes: (prev?.flushes ?? 0) + 1, requests: (prev?.requests ?? 0) + d.dynamic + d.packed + d.fallback + d.errors + d.workflowAdvances.dynamic + d.workflowAdvances.fallback, lastAt: s.updatedAt };
  const ids = Object.keys(s.isolates);
  if (ids.length > ISOLATES) for (const id of ids.sort((a, b) => s.isolates[a]!.lastAt.localeCompare(s.isolates[b]!.lastAt)).slice(0, ids.length - ISOLATES)) delete s.isolates[id];
  return s;
}

/** The DO's RPC surface (TierStats in the tier host). */
export interface StatsService {
  add(d: StatsDelta): Promise<void>;
  read(): Promise<TierStatsState>;
  reset(): Promise<TierStatsState>;
}
export interface StatsNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): StatsService;
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One isolate's side: counts, batches and reports. */
export class StatsReporter {
  private isolate = "";
  private pending: StatsDelta | null = null;
  private flushing: Promise<void> | null = null;
  /** The add() in flight, if any: a read waits for it, not for a timed flush still waiting. */
  private sending: Promise<unknown> | null = null;
  /** This isolate's own totals: what is answered when there is no DO. */
  private own: TierStatsState | null = null;
  readonly flushErrors: string[] = [];

  private readonly kind: StatsDelta["kind"];
  private readonly now: () => number;
  constructor(kind: StatsDelta["kind"], now: () => number = Date.now) {
    this.kind = kind;
    this.now = now;
  }

  private ns(env: Record<string, unknown>): StatsNamespace | null {
    return (env[STATS_BINDING] as StatsNamespace | undefined) ?? null;
  }
  private stub(env: Record<string, unknown>): StatsService | null {
    const ns = this.ns(env);
    return ns ? ns.get(ns.idFromName(STATS_OBJECT)) : null;
  }
  private flushMs(env: Record<string, unknown>): number {
    const n = Number(env["TIER_STATS_FLUSH_MS"] ?? DEFAULT_FLUSH_MS);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FLUSH_MS;
  }

  /**
   * Counts one event. `urgent` (a fallback or an error) flushes now; anything else is flushed by the
   * isolate's next flush, at most `flushMs` later. Never awaits the DO.
   */
  record(env: Record<string, unknown>, ctx: Ctx | undefined, change: (d: StatsDelta) => void, urgent = false): void {
    // Random values and the clock are only usable inside a request, so the identity is made here.
    if (!this.isolate) this.isolate = crypto.randomUUID().slice(0, 8);
    const d = emptyDelta(this.isolate, this.kind);
    change(d);
    this.own ??= emptyState(this.now(), "isolate");
    applyDelta(this.own, d, this.now());
    if (!this.ns(env)) return;
    this.pending = this.pending ? mergeDelta(this.pending, d) : d;
    if (urgent) {
      // Takes whatever is pending now; a timed flush already waiting sends what arrives after.
      const now = this.flush(env);
      if (ctx) ctx.waitUntil(now);
      return;
    }
    if (this.flushing) return;
    const delay = this.flushMs(env);
    // A failed flush keeps its delta; the next event schedules the retry.
    this.flushing = (async () => {
      if (delay) await wait(delay);
      await this.flush(env);
    })().finally(() => {
      this.flushing = null;
    });
    if (ctx) ctx.waitUntil(this.flushing);
  }

  /** Sends the pending delta. On failure the delta is kept for the next flush and the error logged. */
  async flush(env: Record<string, unknown>): Promise<boolean> {
    const stub = this.stub(env);
    const d = this.pending;
    if (!stub || !d) return true;
    this.pending = null;
    const sent = stub.add(d);
    this.sending = sent;
    try {
      await sent;
      return true;
    } catch (e) {
      this.pending = this.pending ? mergeDelta(d, this.pending) : d;
      const msg = `${new Date(this.now()).toISOString()} ${String(e).slice(0, 200)}`;
      this.flushErrors.push(msg);
      if (this.flushErrors.length > 20) this.flushErrors.shift();
      console.error("linker-tiered: stats flush failed; the counts are kept and retried", String(e));
      return false;
    } finally {
      if (this.sending === sent) this.sending = null;
    }
  }

  /** The shared counts (after flushing this isolate's), or this isolate's own when there is no DO. */
  async read(env: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const stub = this.stub(env);
    if (!stub) return { status: 200, body: { ...(this.own ?? emptyState(this.now(), "isolate")) } };
    if (this.sending) await this.sending.catch(() => {});
    await this.flush(env);
    try {
      return { status: 200, body: { ...(await stub.read()), ...(this.pending ? { unflushedHere: this.pending } : {}) } };
    } catch (e) {
      return { status: 503, body: { code: "StatsUnavailable", detail: String(e).slice(0, 300), isolate: this.own, flushErrors: this.flushErrors } };
    }
  }

  async reset(env: Record<string, unknown>): Promise<void> {
    this.pending = null;
    this.own = emptyState(this.now(), "isolate");
    const stub = this.stub(env);
    if (stub) await stub.reset();
  }
}
