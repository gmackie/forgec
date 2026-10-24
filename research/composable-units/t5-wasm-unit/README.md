# T5: a Rust WASM-component unit behind WIT generated from domain-ir

Research spike for FORG-31 (epic FORG-26), stacked on T2 (FORG-28). Design:
[composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html).
Every number below is **local**: one Apple M2 Max (macOS 24.6, arm64), Node 24.14.0, and workerd
through `miniflare@4.20260730.0`. Nothing was measured on deployed Cloudflare Workers. `results.json`
has every measured value. Values that were not measured are listed under `missing`.

## Reproduce

```sh
cargo build -p forgegraph-cli
pnpm install --frozen-lockfile
cargo test -p forgegraph-planner --test wit                # WIT snapshots and diagnostics
pnpm --filter @forgegraph/units test                       # seal both ways, differential in workerd
node examples/pricing/build-component.mjs --check          # component rebuilds byte for byte (needs the toolchain below)
node research/composable-units/t5-wasm-unit/measure.ts     # writes results.json
```

Pinned toolchain for the component: Rust 1.97.1 with target `wasm32-unknown-unknown`
(`examples/pricing/impl/quote-order-rs/rust-toolchain.toml`), `wit-bindgen` 0.63.0 (exact, in
`Cargo.lock`), and `wasm-tools` 1.262.0 (`cargo install --locked wasm-tools@1.262.0`). The JS side
pins `@bytecodealliance/jco` 1.39.0 and `miniflare` 4.20260730.0 (exact) in `packages/units`.

The component is byte-identical across hosts (checked on macOS arm64 and in Linux x86_64 CI), not
just across checkout paths. Besides remapping paths, `build-component.mjs` runs cargo with a
`RUSTC_WRAPPER` that sets `-C metadata=<package>@<version>` for the wasm32 crates. Cargo's own
value hashes `rustc -vV`, including its `host:` line, into the proc-macro dependencies, so the
crate hashes in every v0 symbol differed by host. LTO and `wasm-ld` then laid out the same
functions in a different order, and stripping the names kept that order (FORG-35).

## Which function, and why a new one

None of acme's implemented functions is pure. `SubmitOrder` reads two resources, applies a
transition, calls the payments external and sends a message. `FulfillOrder` and
`RebuildOrderSummary` read `Order`. `AuthorizePayment` is an adapter for a payment provider. A WASM
body for any of them would mostly test capability wiring, which T5 does not do yet (see the gaps
below). acme is also the golden fixture for about 25 suites (`conformance/fixtures/acme.*`,
certification identity, runtime tests). Adding a declaration to it would re-golden all of them and
collide with the parallel FORG-29 and FORG-30 work. So the unit is a new, separate package,
`examples/pricing` (`@acme/pricing`), with one pure function:

```forge
export function QuoteOrder @http(POST, "/v1/quotes") {
  input QuoteOrderInput     # lines: list<QuoteLine>, tier: CustomerTier, taxRateBasisPoints, shipping?
  output OrderQuote         # subtotal, discount, tax, shipping, total (money<USD>), lineCount, topSku?
  errors { EmptyOrder  InvalidTaxRate  QuoteTooLarge }
}
```

It does integer-cent arithmetic: a tier discount, tax rounded half-up, optional shipping, and a
total limit. Its signature still exercises shapes, a list of records, an enum, money,
optional input and output fields, integers and three declared errors.

## What was built

| piece | where |
| --- | --- |
| WIT generation | `crates/forgegraph-planner/src/wit.rs`. `forgec build --units` puts each world in `plan.json` (`units[].wit`) and writes `generated/units/wit/<symbol>.wit`. `forgec wit <app> --unit <name> [--lowering]` prints one world, or exits 1 with `E-WIT-*` diagnostics. |
| Rust unit | `examples/pricing/impl/quote-order-rs` (wit-bindgen against `wit/unit.wit`, a checked-in copy of `forgec wit`), built by `examples/pricing/build-component.mjs` into `impl/quote-order.wasm` (committed, reproducible) |
| JS unit | `examples/pricing/impl/quote-order.ts` (`defineFunction`) over `impl/quote.ts` |
| sealing | `seal(plan, app, { components: { [symbol]: path } })` and `forge-units <app> --component <symbol>=<path>`. The sealer checks the component's world against the generated WIT, stores the component and its lowering as blobs, and marks the unit `kind: wasm-component`. |
| schema | `schemas/closure-manifest.schema.json` gains a `wasm-component` implementation `{component, world, lowering, abi: "forge-wit/1"}`, `.wasm`/`.json` blobs, and `toolchain.transpiler` |
| linker stand-in | `packages/units/src/harness.ts` (Worker modules for one unit behind a fixed caller), `src/wasm.ts` (world check, jco transpile), `src/wit-lowering.ts` (wire value adapter, runs in the Worker) |

### The world

A unit's world is a pure function of its interface. It is always `package forge:unit; world unit`
with one export, `run`, and it never names the unit. Two units with the same interface therefore
get byte-identical WIT (tested), and one component can implement either. The generated world for
QuoteOrder is
[`examples/pricing/impl/quote-order-rs/wit/unit.wit`](../../../examples/pricing/impl/quote-order-rs/wit/unit.wit).
Errors are cases of `variant failure { empty-order(option<string>), … }`, where the payload is the
detail. When the unit has capabilities, there is also a `fault(fault)` case for handle failures. Each
capability becomes an imported interface:

| domain-ir | WIT |
| --- | --- |
| `text`, `id`, `email`, `url`, `timezone`, `countryCode` | `string` (domain type in a `///` note) |
| `integer` | `s64` (the lowering converts wire numbers to and from BigInt; refuses unsafe integers) |
| `boolean` | `bool` |
| `decimal<n>`, `money<C>` | `string`, the canonical decimal (exact, never a float) |
| `date`, `datetime`, `localTime`, `duration` | `string`, ISO 8601 |
| reference / identity | `string` (id) |
| `T?` | `option<T>`; the lowering maps wire `null` to none, and none to `null` |
| `list<T>` / `set<T>` | `list<T>` (set uniqueness noted, not typed) |
| `map<text, T>` | `list<tuple<string, T>>`, sorted by key |
| shape, `X.Record` (non-hidden fields), channel message | `record` |
| enum, `X.Status` | `enum` (the lowering maps wire value to case) |
| `errors { … }` | `result<_, failure>` with one case per error |
| `uses { R read }` | `import resource-r-read { get: func(id) -> result<r-record, fault> }` |
| `uses { R.status.a }` | `import transition-r-a { apply: func(id, expected-version: s64[, input]) -> result<r-record, fault> }` |
| `uses { pkg.F }` | `import function-f { call: func(input) -> result<out, f-failure> }` |
| `sends { M to C }` | `import send-c-m { send: func(payload) -> result<_, fault> }` |

Refused, with a diagnostic: `json` (E-WIT-001); unresolved types (E-WIT-002); two declarations
or fields that lower to the same WIT name, such as `taxRate`/`tax_rate`, same-named shapes from
two packages, or an error named `Fault` next to capability faults (E-WIT-003); recursive shapes
(E-WIT-004); `write`/`create`/`delete` handles, workflow `wait` and `sleep` (E-WIT-005); names
WIT cannot spell (E-WIT-006); and empty records or enums (E-WIT-007). A unit whose world is
unsupported stays a js-module. The sealer refuses to bind a component to it and prints the
diagnostics. Snapshots: `crates/forgegraph-planner/tests/snapshots/wit__*.snap`. Every lowering in
the table appears in `every_lowered_type_kind_wit`, and acme's `SubmitOrder` and `FulfillOrder`
show the capability imports. Every snapshot parses with `wasm-tools component wit`.

### Identity

The sealed manifest for QuoteOrder, bound each way:

| | js-module | wasm-component |
| --- | --- | --- |
| interfaceHash | `sha256:b686c06b…` | `sha256:b686c06b…` (same) |
| implementationHash | `sha256:42504b48…` | `sha256:14876cdd…` |
| unitHash | `sha256:7ba12e3c…` | `sha256:0b854f16…` |

The route `POST /v1/quotes` gets a different closureHash, and every other field of the entry point
is identical (tested). The wasm implementation is `{component, world, lowering, abi}`. `world` is the
digest of the WIT the sealer checked the component against. The check compares the component's
world with a component jco builds from the generated WIT: the root world plus jco's type
declarations for every interface the world reaches, because `componentWit` alone prints only the
root world. A component built before an error was added fails to seal (tested).

### Running it: one caller, either implementation

The harness gives the Worker a fixed `caller.js` (identical bytes for both kinds, tested) that
imports `invoke` from `./bound.js`. For a wasm-component, `bound.js` instantiates the jco glue
(`instantiation: "async"`, no WASI shim) with the core module shipped as a `CompiledWasm` module
import, because a Worker cannot compile WASM bytes at runtime. It then adapts wire values with the
lowering. For a js-module, `bound.js` runs the sealed module's `FunctionImpl` through Effect.

**Differential: 214 inputs, 0 differences.** These are 14 hand-written cases (half-up rounding,
`12`/`12.5`/`12.50`, a free order with no `topSku`, a tie, unicode SKUs, empty, tax above 100%,
the limit and one cent over it, i128 overflow, and 1000 lines) plus 200 seeded random quotes. Each
ran in workerd behind the same caller. The outputs are deep-equal to each other and to
`quote()` called directly in Node, including the four declared failures and their detail strings.

## Measurements (local)

### Size

| artifact | raw | gzip |
| --- | ---: | ---: |
| component `impl/quote-order.wasm` | 24,728 | 11,140 |
| after transpile: core module | 23,831 | 10,674 |
| after transpile: glue, minified (the harness setting) | 47,540 | 13,140 |
| after transpile: glue, unminified | 117,318 | 26,099 |
| core after `wasm-opt` (jco `optimize`) | 21,135 | 10,102 |
| lowering blob | 3,878 | 693 |
| Worker upload, wasm variant (caller + bound + glue + core) | 80,917 | 26,356 |
| Worker upload, js variant (caller + bound incl. Effect) | 209,846 | 46,926 |
| the JS unit's own sealed module | 2,488 | 1,122 |

Transpiling is deterministic: the same component gives the same glue and core bytes. The glue is
twice the core module and does not depend much on the unit, so it is mostly per-component
fixed cost: async-task, handle-table and string intrinsics. Effect dominates the js variant. A real
host loads it once for all units.

### Per-call cost

These numbers are from inside workerd: the median of 7 runs of n calls within one request, with
the caller awaiting each call. The in-Worker clock reads whole milliseconds, so n is sized to make
each run take at least about 37 ms.

| payload | JSON bytes | wasm-component | js-module (Effect) | plain JS fn | wasm / js-module |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 line | 121 | 3.18 µs | 0.76 µs | 0.51 µs | 4.2× |
| 10 lines | 605 | 8.1 µs | 2.1 µs | 1.9 µs | 3.9× |
| 100 lines | 5,537 | 56.5 µs | 25.0 µs | 24.5 µs | 2.3× |
| 1000 lines | 54,827 | 530 µs | 265 µs | 270 µs | 2.0× |

The breakdown below was measured in Node, which uses the same glue and core and is also V8:

| payload | wasm unit | glue + wasm | lowering adapter | plain JS |
| --- | ---: | ---: | ---: | ---: |
| 1 line | 6.9 µs | 6.2 µs | 0.7 µs | 0.53 µs |
| 10 lines | 12.0 µs | 10.0 µs | 2.0 µs | 2.5 µs |
| 100 lines | 59.3 µs | 40.4 µs | 18.8 µs | 22.1 µs |
| 1000 lines | 520 µs | 339 µs | 181 µs | 207 µs |

Findings:

- **About 2–3 µs fixed cost per crossing in workerd** comes from the jco glue: task bookkeeping and
  a debug-log hook. Node pays more, because the glue's `_debugLog` reads
  `globalThis.process.env.JCO_DEBUG` on every step. With that one read replaced by `false`, a
  1-line call drops from 6.07 µs to 1.91 µs (`perCall.node.debugLogProbe`). workerd without
  `nodejs_compat` has no `process`, so it does not pay this cost. With `nodejs_compat` it would.
- **The per-byte cost does not go away with size.** At 1000 lines the WASM unit is still about 2×
  slower. Each SKU and price string is UTF-8 encoded into linear memory, with one `realloc` each,
  and decoded again on the way out. The wire→jco adapter adds as much again, because it rebuilds
  every record and converts integers to BigInt. For this workload the computation is cheaper than
  the copying, so string-heavy, compute-light units should stay JS. A WASM unit pays off only when
  its compute is large relative to its input and output.
- The JS unit's Effect wrapper costs about 0.25 µs per call over the bare function.

### Instantiation

| | value |
| --- | --- |
| workerd: first `instantiate()` in a fresh isolate (precompiled core) | median 0 ms over 10 isolates; readings were 0–1 ms on the ms clock |
| workerd: first call including instantiation | wasm 2–5 ms, js 0–1 ms (5 isolates each) |
| Node: `WebAssembly.compile` of the core module | 0.085 ms (in Workers, the upload pays this) |
| Node: `instantiate()` with the compiled module | median 0.151 ms, p90 0.181 ms |
| Node: first call after instantiate | 0.102 ms |

### Missing

- Deployed Cloudflare Workers: cold start, CPU time per call, and isolate memory. Not measured.
- The effect of script size on real cold start for a closure of many units.
- Calls through capability imports (WASM → host handles). The unit is pure, and the harness refuses
  a lowering with imports.
- Components from sources other than Rust (componentize-js, etc.).

## Gaps and design questions

1. **The interface hash does not cover imported types.** A world's import interfaces carry
   `R.Record` for `uses { R read }` and the callee's signature for `uses { F }`. The T2 interface
   covers only the types reachable from input and output. If `Site` gains a field,
   `SubmitOrder`'s world changes but its interfaceHash does not. The sealer's world check catches
   the stale component, but should the interface include the types reached through capabilities,
   or the world digest?
2. **Type names are nominal and lose their package.** WIT has `quote-line`, and the interface has
   `@acme/pricing/_/QuoteLine`. Two packages' `Line` shapes in one world are refused (E-WIT-003).
   The options are to package-qualify WIT names (`acme-pricing-quote-line`) or to make the interface
   key types structurally.
3. **Refinements are not in WIT.** `length 1..64`, `>= 1` and set uniqueness are documented, not
   typed. A WASM unit relies on the runtime decoder having validated its input. Domain `integer`
   is `s64`, but the JS wire is a double, so values above 2^53 cannot cross.
4. **Money as a decimal string** is exact and matches the wire, but every unit has to parse it. A
   `record decimal { minor: s64, scale: u8 }` is cheaper at the boundary but caps magnitude.
5. **Capability imports are async in JS (Effect) and sync in WASM.** To wire them we need JSPI
   (`asyncMode: "jspi"`), component-model async, or a rule that a WASM unit's imports run before
   the call (prefetch). Is JSPI available on Workers?
6. **Glue per component.** The glue is about 47 KB minified per component and is not shared, while
   the cost of a crossing is in the glue, not the canonical ABI. forgec already knows every type,
   so it could emit a lean direct-call glue from the lowering. Alternatively, the linker could merge
   chatty WASM units into one component.
7. **Who chooses the implementation?** Today the sealer invocation does (`--component`). Should
   `impl/` declare components (for example `export const components = {…}` in `impl/index.ts`), so
   the deployment owns the choice and the manifest is reproducible from source alone?
8. **The component is committed.** It reproduces byte for byte on macOS and Linux, but only with the
   pinned toolchain.
   Should CI build it, or keep checking the committed bytes with `build-component.mjs --check`? Note
   that reformatting the Rust changes the bytes, because panic locations embed line numbers.
