# R3: a WASM instance pool for concurrent unit calls

Research for FORG-41, following [R2](../r2-wasm-async/README.md) (FORG-36). R2 found that jco
serializes calls on one component instance. A JSPI-lifted export takes the instance's exclusive
lock, so while one call is suspended on a capability read, the next call on the same isolate waits
for it. Two concurrent PriceCart calls took 130 ms against 58 ms for one, while the JS unit
interleaved them in 46 ms. This spike measures how a linker should map concurrent calls to
instances, implements the winner in the harness, and tests it.

Every number below is **local**: one Apple M2 Max (macOS 24.6, arm64, 12 cores), Node 24.14.0, and
workerd through `miniflare@4.20260730.0`, jco 1.39.0. Nothing ran on deployed Cloudflare Workers.
The machine was shared with other heavy jobs throughout, with a load average of 150 to 250 on 12
cores. Absolute times are noisy, and runs disagree by up to 2x on the same row. The script ran five
times. `results.json` holds the last run in full, plus a summary of the other four under
`otherRuns`. Every conclusion below held in all five runs. `missing` lists what was not measured.

## Reproduce

```sh
cargo build -p forgegraph-cli
pnpm install --frozen-lockfile
pnpm --filter @forgegraph/units test -- --testTimeout=60000   # pool, concurrency and trap tests, differential
node research/composable-units/r3-wasm-pool/measure.ts        # writes results.json (about 4 min)
```

## The options

Every variant is the harness's own `bound.js` (`transpiledModules(t, lowering, instances)` in
`packages/units/src/harness.ts`), with only the instance strategy changed:

| strategy | what it does |
| --- | --- |
| `shared` | one instance for every call (the harness before this change) |
| `fresh` | a new instance per call from the compiled core modules (they are `CompiledWasm` module imports, compiled at upload), dropped after the call |
| `pool(4)`, `pool(32)` | a bounded pool: an instance per in-flight call up to 4 or 32, and every idle one kept. Calls beyond the bound wait in FIFO order for a released instance. |
| `elastic(8)`, `elastic(32)` | no bound: an instance per in-flight call, keeping at most 8 or 32 idle and dropping the rest when released |

All the pool variants are `instancePool` (`packages/units/src/pool.ts`) with different
`{ max, idle }`. In every pooled variant, a call that throws discards its instance.

Other options considered and not built:

- **Interleaving calls on one instance** (no lock). This is not credible. A Rust component keeps
  its shadow stack pointer and allocator state in one linear memory, and two suspended calls on it
  would interleave their stack frames. jco's lock exists for this reason.
- **An instance per request, made by the caller.** This is `fresh` with a different owner. It
  costs the same and needs the caller to know the callee's kind, which the harness exists to hide.

Workload: PriceCart with a 5-item cart, so 5 sequential `Product` reads through the JSPI import. In
the `io` host, every read waits 5 ms (`scheduler.wait`), so the ideal is about 25 ms per call at any
concurrency. In the `memory` host, reads resolve from memory with no I/O, so the cost is all
mechanism. Concurrent calls are `Promise.all` inside one request on one isolate. That is the same
instance sharing as concurrent requests to one isolate, without HTTP noise.

## Instantiation and memory

| | last run | range over 5 runs |
| --- | ---: | ---: |
| bare instantiation (jco `instantiate`: 3 core instances) | 0.25 ms | 0.25–0.81 ms |
| a 5-read call on a warm instance (memory host) | 0.61 ms | 0.09–0.61 ms |
| instantiate + the same call | 1.65 ms | 0.74–1.65 ms |
| linear memory per instance, fresh / after 200 calls | 1,114,112 B (17 pages) / 1,179,648 B (18) | same |
| workerd RSS per held instance (200 held) | 81.8 KiB | 79–82 KiB |

A PriceCart instance is three core instances: the unit's module and jco's two JSPI trampolines. The
first instance costs nothing extra, because the core modules arrive compiled. A bare instantiation
costs about as much as a warm 5-read call, or a few times more, depending on the run. RSS grows by only about 80 KiB per instance, because untouched
linear memory pages are not resident. The 1.1 MiB per instance is still allocated, and it is what
an isolate's memory accounting is likely to count. That was not measured on Workers.

## Concurrent throughput

`io` host (5 reads × 5 ms per call), ms per round of `c` concurrent calls, last run (load average
about 225). `S` marks rows where the reads did **not** interleave, meaning calls ran one after
another.

| strategy | c=1 | c=2 | c=8 | c=32 | c=64 | instances created over the c=64 row |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| js-module | 46 | 47 | 92 | 245 | 373 | – |
| shared | 52 | 105 S | 406 S | 1,532 S | 3,048 S | 1 |
| fresh | 62 | 71 | 217 | 695 | 1,075 | 975 |
| pool(4) | 43 | 49 | 146 S | 414 S | 770 S | 4 |
| **pool(32)** | **37** | **45** | **121** | **362** | **581** S | **32** |
| elastic(8) | 38 | 46 | 95 | 407 | 1,026 | 728 |
| elastic(32) | 42 | 47 | 145 | 433 | 799 | 320 |

An earlier run at a lower load (about 155) shows the shape more cleanly. All rows except c=64 were
measured. Times are ms:

| strategy | c=1 | c=2 | c=8 | c=32 |
| --- | ---: | ---: | ---: | ---: |
| js-module | 31 | 31 | 31 | 32 |
| shared | 32 | 64 S | 254 S | 1,014 S |
| fresh | 30 | 30 | 34 | 57 |
| pool(4) | 31 | 32 | 59 S | 247 S |
| pool(32) | 32 | 32 | 31 | 39 |
| elastic(8) | 31 | 32 | 31 | 52 |
| elastic(32) | 32 | 32 | 32 | 40 |

`memory` host (no I/O), ms per round, mean of 200 rounds, last run:

| strategy | c=1 | c=2 | c=8 | c=32 |
| --- | ---: | ---: | ---: | ---: |
| js-module | 0.08 | 0.10 | 0.22 | 0.44 |
| shared | 0.33 | 0.31 S | 1.30 S | 2.21 S |
| fresh | 1.56 | 2.33 | 7.72 | **319.9** |
| pool(4) | 0.57 | 0.38 | 1.21 S | 2.67 S |
| pool(32) | 0.33 | 0.49 | 1.42 | 5.09 |
| elastic(8) | 0.26 | 0.35 | 2.14 | **140.6** |
| elastic(32) | 0.46 | 0.26 | 1.10 | 7.75 |

Findings:

- **`shared` serializes completely.** Its throughput is flat at about 20–31 calls/s with I/O
  whatever the concurrency, which is one call's latency times `c`. At c=32 it took 6–32x the JS
  unit's time, depending on the run.
- **An instance per in-flight call removes the serialization.** With I/O, `pool(32)` and
  `elastic(32)` interleave every call in every run, as the JS unit does. Their time against the JS
  unit's is within the machine's noise. At c=32, `pool(32)` took 0.4x to 6.8x the JS unit's time
  across the five runs. In the run at the lowest load it took 39 ms against 32 ms, with the ideal
  at 25 ms. What held in every run is the interleaving and the gap to `shared`.
- **Instantiating per call does not scale.** Instantiating one instance costs under 1 ms, but 32
  concurrent `fresh` calls with no I/O took 317–339 ms a round in every run (about 10 ms per
  call), 60–80x `pool(32)`. Concurrent instantiations under jco 1.39 appear to cost far more than one alone. The
  cause was not isolated. jco's async glue polls its task state with `setTimeout`, which is one
  suspect. `elastic(8)` shows the same collapse at c=32: it keeps 8 idle, so every round
  re-creates 24 instances (4,808 created over the row). **Keep as many idle instances as the peak
  concurrency.**
- **A bound costs little and caps memory.** Past the bound, `pool(32)` at c=64 queues (`S`), yet
  it was still the fastest WASM strategy at c=64 in all three runs that measured it. `elastic(32)`
  without a bound kept creating and dropping instances past 32 idle. The bound also caps an
  isolate at 32 × 1.1 MiB of linear memory for this unit.
- **With no I/O, the pool costs something.** At c=32 with in-memory reads, `pool(32)` took
  4.0–5.6 ms a round against 2.2–3.2 ms for `shared`, slower in every run. With nothing to wait on,
  serializing loses nothing, while 32 instances each run their own glue state. The cause was not
  isolated. Capability reads are I/O in practice (D1 is about 1 ms locally and a network round trip
  on Workers), and there the pool was 2–26x faster than `shared` at c=8 and c=32. That trade is why it
  wins.
- **The WASM mechanism stays slower than JS with no I/O.** A WASM call takes 3–12x the JS unit's
  time with in-memory reads under every strategy. That cost is jco's import glue (R2), not instance
  management, and pooling does not change it.

## Failure mid-call

Three calls start at once on one isolate, with every read waiting 5 ms. Call `x` fails on its last
read, after its earlier reads have resumed. Calls `a` and `b` are good and suspended at the same
time. Then three sequential calls and two concurrent calls follow. Each call races a 2 s timer, so
a hang would show. The results are `failure` in `results.json`.

| failure | shared | fresh, pool(n), elastic(n) | js-module |
| --- | --- | --- | --- |
| **trap** (the unit `abort()`s on a price it cannot parse) | `x` traps. `b`, queued behind it on the same instance, **also fails** with the trap. **Every later call fails**: `wasm trap: cannot enter component instance`. | `x` traps, and only its instance is discarded (`discarded: 1`). `a`, `b` and all five later calls price correctly. | `x` throws, everything else is correct |
| **throw** (the host handle throws, a host defect) | `x` fails with the host's error, and the instance survives in jco | `x` fails, its instance is discarded anyway, and everything else is correct | same |
| **declared failure** (the handle's `NotFound`) | `x` returns `NotFound`, the instance is reused | same, and the instance goes back to the pool (`discarded: 0`) | same |

A trap poisons a jco instance permanently. jco sets a per-instance trap flag, and the component
model forbids re-entering a trapped instance. So under `shared`, one bad input takes the unit down
for the rest of the isolate's life. jco's trap state is per `instantiate` call, not per glue
module, so a trap in one pooled instance never affects another: every pooled variant above shows
this. The pool discards on **any** throw, including host defects the instance survives, because
the harness cannot tell from the outside whether a throw left the instance usable. That costs one
instantiation per defect.

## The chosen strategy

**`pool(32)`: an instance per in-flight call, up to 32, and every idle instance kept.** It is
`DEFAULT_POOL = { max: 32, idle: 32 }` in `packages/units/src/pool.ts`, and the harness binds every
wasm-component this way (`transpiledModules`, `bindUnit`).

- Acquiring takes the most recently released idle instance (LIFO, so warm instances stay warm).
  Otherwise it creates one if fewer than 32 are alive, and otherwise the call waits in FIFO order.
- A call that returns, with a value or a declared failure, releases its instance. A call that
  throws discards it, and a waiting call then gets a fresh instance, never the discarded one.
- `ready()` warms one instance, so a host that lacks a declared capability still fails closed
  before the first call, as before.
- A pure unit (no imports, so a synchronous export) goes through the same pool. It never suspends,
  so in practice it reuses one instance, and a trap in it is now isolated too.

**Not configurable.** `BindOptions.instances` and the `instances` parameter of
`transpiledModules` exist so that the measurement and the tests can bind the other strategies
(including `"shared"`, to show what the pool removes). The defaults are fixed. The evidence does
not call for per-unit tuning yet. One unit was measured, and 32 is both above the concurrency
measured to matter and well inside an isolate's memory. A unit with a much larger linear memory
might warrant a smaller bound. That is an open question, not something these numbers show.

**Linker B** (`packages/linker-dynamic`) does not load WASM units. Its manifest check reports a
wasm-component as missing (`this linker does not load them yet`). So nothing changed there. When it
learns to load them, it should bind them through the same pool.

## Tests

- `packages/units/test/pool.test.ts`: the pool on its own, with stand-in instances. It covers an
  instance per in-flight call, LIFO reuse, discard on a throw (async or sync), waiters beyond `max`,
  a waiter getting a fresh instance when the busy one is discarded, the idle limit, a failing
  `create` freeing its slot, and the defaults.
- `packages/units/test/wasm-async.test.ts`, "concurrent calls on one isolate (FORG-41)", in workerd:
  8 concurrent PriceCart calls of 4 reads each, every read waiting 20 ms.
  - The pooled wasm-component interleaves its reads exactly like the js-module: every call's
    first read comes before any call's second. Both finish in well under the serialized time.
  - The `"shared"` binding of the same component serializes (`c0-1 … c0-4` first), so the test
    can tell the difference.
  - A trap mid-call, while two good calls are suspended, fails only that call. The suspended calls
    and five later ones, sequential and concurrent, all price correctly, as with the js-module.
  - Under `"shared"`, every call after a trap fails with `cannot enter component instance`.
- The R2 differential (210 carts, js-module against wasm-component over D1) and the T5 tests are
  unchanged and still pass under the pool.

## Missing

- Deployed Cloudflare Workers: how production isolates account wasm linear memory against the 128
  MB limit, cold start, and CPU time per call. Everything here is local workerd.
- Why concurrent instantiation under jco 1.39 costs about 10 ms per instance while a sequential
  one costs under 1 ms. The effect was measured in every run, but the cause was not isolated.
- Stack memory per suspended call (JSPI's secondary stack). It is inside the RSS figures but not
  attributed.
- Clean timings on an idle machine. Load average was 150–250 on 12 cores in every run.
- Concurrency beyond 64, and a unit other than PriceCart (another component's linear memory, and
  so the right bound, may differ).
- One discarded run: an earlier version of the script ran 200 no-I/O rounds in one request and
  failed with workerd's `QuotaExceededError` (10,000 active timeouts per request). Which strategy
  hit it was not recorded. jco's glue schedules `setTimeout` for its task polling and deadlock
  check, which is the likely source. The script now splits those rounds over 8 requests.
