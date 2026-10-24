# R2: capability calls from WASM units

Research for FORG-36, following [T5](../t5-wasm-unit/README.md) (FORG-31). In T5 the WASM unit was
pure: capability imports appeared in the generated WIT, but the harness refused any unit that had
them. The problem is that a capability call is async in JS (D1 and every other store), while a
core WASM import is a synchronous call. This spike evaluates the ways to bridge that, wires the
best one end to end, and makes `interfaceHash` cover the types a unit reaches through its
capabilities.

Every number below is **local**: one Apple M2 Max (macOS 24.6, arm64), Node 24.14.0, and workerd
through `miniflare@4.20260730.0` (workerd 2026-07-30), jco 1.39.0. Nothing ran on deployed
Cloudflare Workers. The machine was shared with other heavy jobs during the recorded run (load
average about 165 on 12 cores, read with `uptime` right after it). Absolute times are therefore
noisy, and some rows are not monotonic. The conclusions below are the ones that also held in an
earlier run of the same script. That run's file was overwritten. `results.json` has every value
recorded, and `missing` lists what was not measured.

## Reproduce

```sh
cargo build -p forgegraph-cli
pnpm install --frozen-lockfile
cargo test -p forgegraph-planner --test units --test wit          # interfaceHash and WIT tests
pnpm --filter @forgegraph/units test                              # differential in workerd, both components rebuild
node examples/pricing/build-component.mjs --check                 # both committed components reproduce byte for byte
node research/composable-units/r2-wasm-async/measure.ts           # writes results.json (about 30 min, mostly P3)
```

The toolchain is T5's: Rust 1.97.1, wit-bindgen 0.63.0 and wasm-tools 1.262.0. The P3 variant in
`measure.ts` is built in a temporary directory with the same toolchain plus wit-bindgen's `async`
feature.

## The unit

`examples/pricing` gains a `Product` resource and `PriceCart`, which reads one `Product` per cart
item:

```forge
export function PriceCart @http(POST, "/v1/carts/price") {
  input PriceCartInput      # items: list<CartItem { product: id, quantity }> length <= 100
  output CartPrice          # lines: list<CartLine { sku, quantity, amount: money<USD> }>, subtotal
  uses { Product read }
  errors { CartTooLarge  EmptyCart  InactiveProduct }
}
```

An N-item cart makes N capability calls, so the per-call cost can be read off the slope. A
missing product is the handle's `NotFound` fault, passed through unchanged by both
implementations.

| piece | where |
| --- | --- |
| Rust unit | `examples/pricing/impl/price-cart-rs` (wit-bindgen against `wit/unit.wit`, the checked-in `forgec wit --unit PriceCart`). It calls `products::get(id)` as a plain synchronous function. |
| component | `impl/price-cart.wasm`, built by `build-component.mjs` (now builds both crates), committed, reproducible |
| JS unit | `impl/price-cart.ts` (`defineFunction`, `deps.resources.Product.get`) over `impl/cart.ts` |
| harness | `packages/units/src/harness.ts`: a `host.js` module provides capability handles (`D1_RESOURCE_HOST` reads a D1 table). The wasm binding transpiles with JSPI, and the js binding builds its `FunctionContext` over the same handles. |
| lowering | `packages/units/src/wit-lowering.ts`: `bindImports` adapts jco values to wire values for each declared import. A handle's `{ ok: false, code, detail }` becomes the import's `err` (a fault, or a callee failure case). `bindExport` is async when the world has imports. |
| tests | `packages/units/test/wasm-async.test.ts`, `crates/forgegraph-planner/tests/{units,wit}.rs` |

**Differential: 210 carts, 0 differences.** These are 10 hand-written cases (one item, the same
product twice, free, a unicode SKU, empty, inactive, missing, i128 overflow, 100 items) plus 200
seeded random carts that hit every outcome. Each ran in workerd behind the same `caller.js` and
`host.js` bytes, both reading from the same D1 store. The outputs are deep-equal to each other and
to `priceCartIn()` run directly in Node. A unit whose host lacks a declared capability fails
closed for both kinds.

## The options, with evidence

| option | works here? | evidence (`results.json`) | cost | limits |
| --- | --- | --- | --- | --- |
| **JSPI** (`WebAssembly.Suspending` / `promising`), through jco `asyncMode: "jspi"` | **yes, chosen** | `support.jspiInWorkerd`: a real suspension (a timer awaited inside the import) works with no flag, with `nodejs_compat`, with `experimental`, and at compat date 2024-01-01. Node 24 (V8 13.6) needs `--experimental-wasm-jspi` (`support.jspiInNode`). End to end with D1: the differential above. | Raw JSPI round trip 0.47 µs vs 0.03 µs for a sync import (`perCall.rawJspi`). Through jco's glue, about 10–24 µs per capability call with an in-memory handle (see below). Glue +475 B minified over sync. | jco calls it EXPERIMENTAL. A sync-lifted export takes the component's exclusive lock, so concurrent calls on one instance are **serialized** (`concurrency`). Deployed Workers not checked. |
| **Component-model async** (WASI P3: `async func` in WIT, wit-bindgen `async`) | builds and runs, **not viable** | `p3`, `correctness["wasm-p3-async"]`: same outputs. jco 1.39's host-import path still uses `WebAssembly.Suspending` (fails in Node without the JSPI flag), so P3 does not remove the JSPI dependency. | **About 1.2–1.5 ms per capability call** even with an in-memory handle: jco drives async tasks from a `setTimeout` tick loop (0 ms after a resume, 10 ms when idle). Component 45.6 KB vs 25.4 KB, glue 94 KB vs 65 KB. | Changes the world (`async func`), so it would be a new ABI. Pre-standard. |
| **Prefetch / batch**: the host resolves the reads before the call, and a sync import answers from that cache | works for this unit, **not general** | `correctness["wasm-prefetch"]`, `perCall.*["wasm-prefetch"]` | Cheapest wasm path with in-memory handles in the earlier run (about 4 µs per item); with D1 it can win outright, because the reads run concurrently (100 items: 59 ms vs 124–160 ms) | Needs a read plan the language does not have: `CartItem.product` is an `id`, so nothing says which input paths a read will use. Here it was written by hand (`items[].product`). A read that depends on an earlier result (read an order, then its site) cannot be prefetched. Reads happen even when the unit fails early, and a miss needs a defined fault (`NotPrefetched`). |
| **Asyncify** (binaryen) | **not built** | `sizes.asyncify` | Core module +62% after -O2 (21,044 → 34,042 bytes) | jco has no asyncify mode. It would need hand-written glue that unwinds and rewinds around jco's lowering of each import result. Instrumentation slows every call, suspending or not. |
| Restart / replay (throw on a miss, fetch, re-run) | not built | none | re-runs the computation once per round of reads | Only for pure, deterministic units. It is prefetch discovered at run time. |

Why JSPI: the Rust unit stays ordinary synchronous code, the WIT world does not change (`func`,
not `async func`), so one component and one world serve sync and async hosts, and nothing in the
language or the manifest changes. The linker derives the transpile mode from the lowering: any
import means JSPI. The sealed manifest is unchanged, apart from the new unit.

## interfaceHash covers the types capabilities reach

Before this change, a function unit's interface covered only the types reachable from its input
and output, while its WIT world also imported the records and signatures its capabilities carry.
If `Product` gained a field, `PriceCart`'s world changed but its `interfaceHash` did not. Now
(`crates/forgegraph-planner/src/{wit,units}.rs`, `capability_surface` next to `import_iface`):

- `types` also takes, as roots, what each capability reaches, the same as the WIT imports: a
  resource capability's record, a transition's record and input fields, a callee's input and
  output, and a sent message.
- `capabilitySignatures` (present only when the unit has capabilities) records each one:
  `{record}`, `{record, input}`, `{input, output, errors}` (the callee's errors, which become its
  failure variant in WIT), and `{payload}`.
- A pure unit's interface is unchanged, so its hash is too: QuoteOrder still hashes to T5's
  `sha256:b686c06b…`. Docs and routes stay out of the hash, as before.
- This applies to every resource capability, including `write`, which WIT does not lower yet: a JS
  implementation reaches the record through it the same way. Workflow units are unchanged. Their
  callees are reached by the step graph, which is the implementation.

Tests: `interface_hash_covers_types_reached_through_capabilities` edits only what a capability
reaches: a read resource's field (added, or its type changed), a transition's input, a callee's
input, output and errors, and a message payload. Each edit moves both the interface hash and the
WIT digest; it fails without the change. `a_pure_unit_has_no_capability_signatures` checks a pure
unit. In workerd (`wasm-async.test.ts`), adding `weightGrams` to `Product` changes `PriceCart`'s
interfaceHash and world, leaves `QuoteOrder`'s unchanged, and makes the committed component fail
to seal.

## Measurements (local, loaded machine)

Per invocation in workerd. These are medians of runs of n awaited invocations inside one request
(7 runs, 5 for D1), timed by the whole-millisecond in-Worker clock. memory: the handle resolves
from an in-isolate `Map`, so no I/O, and the mechanism is all that is timed. d1: the harness's
local D1 store.

| memory host | 1 item | 10 items | 100 items | per extra item |
| --- | ---: | ---: | ---: | ---: |
| wasm-component (JSPI) | 54.8 µs | 791 µs | 2,915 µs | 23.6 µs |
| js-module (Effect) | 5.6 µs | 23.0 µs | 248 µs | 2.5 µs |
| wasm prefetch (sync glue) | 15.1 µs | 166 µs | 3,772 µs | 40.1 µs |
| plain JS async function | 2.2 µs | 7.5 µs | 325 µs | 3.5 µs |
| wasm P3 async | 3,223 µs | 26,067 µs | 163,000 µs | 1,521 µs |

| D1 host | 1 item | 10 items | 100 items | per extra item |
| --- | ---: | ---: | ---: | ---: |
| wasm-component (JSPI) | 2.12 ms | 14.2 ms | 160.5 ms | 1.63 ms |
| js-module (Effect) | 2.16 ms | 19.3 ms | 123.9 ms | 1.16 ms |
| wasm prefetch (concurrent reads) | 2.06 ms | 9.1 ms | 59.5 ms | 0.56 ms |
| plain JS async function | 2.16 ms | 12.8 ms | 115.2 ms | 1.14 ms |
| wasm P3 async | 4.09 ms | 36.6 ms | 383.4 ms | 3.85 ms |

The earlier, less loaded run gave about a third of these times with the memory host. There the
marginal cost per item was 9.6 µs for wasm with JSPI, 0.67 µs for the js-module, 4.1 µs for
prefetch and 1.2 ms for P3. With D1, wasm with JSPI and the js-module were within 2% of each other
at 1 item.

Raw JSPI, without jco (`perCall.rawJspi`, the WAT probe module, one import per `run()`): a sync
import 30 ns, `promising()` entry with a sync import 315 ns, a suspending import 465 ns, and an
async JS function 90 ns.

Concurrency (`concurrency`): two invocations at once on one isolate, 5 reads each, 5 ms per read.
For the js-module they took 46 ms against 55 ms for one, with reads interleaved `a1 b1 a2 b2 …`. For
the wasm component they took 130 ms against 58 ms for one, with reads `a1…a5` and then `b1…b5`.

Findings:

- **JSPI itself is cheap (under 0.5 µs per suspension), but jco's async-import path is not.**
  Every import call is a subtask with task bookkeeping, and it lowers a whole record (four fields,
  three strings) from wire values to jco values to linear memory. With an in-memory store, a WASM
  unit pays roughly 10–20 µs more per capability call than the JS unit. As T5 found for the
  export, the cost is in the glue and the copying, not the ABI.
- **With a real store, the mechanism disappears into I/O.** A local D1 read is about 0.6–1.6 ms,
  and the wasm-to-js ratio was 0.7–1.6× across cart sizes, within noise. On Workers, D1 is a
  network round trip, so the gap shrinks further. It matters only for chatty units over cached or
  in-isolate data.
- **One instance serializes calls.** While a call is suspended on I/O, a second request on the
  same isolate waits for the instance. A linker should give each in-flight request its own
  instance (instantiation was about 0.15 ms in T5) or pool instances. This is the main operational
  cost of JSPI here.
- **Prefetch is a batching win, not a mechanism win.** It is fast with D1 because the reads run
  concurrently. A JSPI unit gets the same benefit if a batched `get-many` import is added to the
  WIT, with no read plan needed.
- **P3 is not ready on this stack.** With a timer per capability call, it is two to three orders
  of magnitude slower, and it still needs JSPI.

## Missing

- Deployed Cloudflare Workers: whether production isolates expose JSPI the way local workerd does
  (Python Workers rely on it, but this was not checked), cold start, CPU time per call and isolate
  memory. Not measured.
- Stack memory per suspended call (each `promising()` call runs on a secondary stack). Not
  measured.
- Clean timings on an idle machine. The recorded run was under heavy external load (see above).
- Import kinds other than `resource read` in workerd. Transitions, callees and sends go through
  the same lowering-driven `bindImports`, and `capabilitySignatures` covers them, but no WASM unit
  in this repo uses them yet.
- Asyncify running end to end. Only the size was measured.

## Open questions

1. Instance per request or a pool: the linker has to choose, given the serialization above.
2. A `get-many` (batched read) import in the WIT for `uses { R read }`, so chatty units can batch
   without a prefetch plan.
3. Should `forge-wit/1` record that imports run under JSPI (an `async: "jspi"` on the wasm
   implementation)? Today the linker derives it from the lowering, so the manifest does not say.
