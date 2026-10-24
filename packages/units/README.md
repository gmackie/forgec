# @forgegraph/units

**Stability: internal (research, FORG-28).** Not published.

Turns the unit plan written by `forgec build --units` into a Closure Manifest
(`schemas/closure-manifest.schema.json`):

```sh
forgec build examples/acme --units          # generated/units/plan.json
node packages/units/src/cli.ts examples/acme # generated/units/manifest.json + modules/<sha256>.js
```

or `pnpm --filter @acme/commerce-deploy units:build`.

The split: forgec owns everything derived from DomainIR (unit boundaries, interface hashes,
capability imports, bindings, forge-native implementation digests) and stays free of a
JavaScript toolchain. This package owns everything that needs `impl/` bytes: it finds each unit's
body statically (`defineFunction("<id>")`, the `externals` map in `impl/index.ts`), bundles it with
esbuild into one ESM module whose default export is the body (the runtime and Effect stay
imports the linker provides), hashes the module, derives unit hashes bottom-up through
dependencies, and resolves every entry point's closure. A js-module unit with no body, a body
for an unknown unit, or a dependency cycle fails here, before anything is deployed.

Findings are a text scan of each unit's own sources for authority that bypasses capability
handles (raw `env`, `fetch`, platform modules, randomness, clocks). They are evidence for
review, not a sandbox.

## WASM components (FORG-31)

A function unit can be bound to a WebAssembly component instead of its `impl/` module:

```sh
forgec wit examples/pricing --unit QuoteOrder   # the WIT world generated from DomainIR
node packages/units/src/cli.ts examples/pricing --component @acme/pricing/_/QuoteOrder=impl/quote-order.wasm
```

The sealer checks that the component's world is the one forgec generated for the unit and refuses
it otherwise. It stores the component and the unit's WIT lowering as blobs and marks the unit
`kind: wasm-component`. The interface hash does not change; the implementation and unit hashes do.
`src/harness.ts` stands in for a linker. It transpiles the component with jco to core module(s)
plus glue, and `src/wit-lowering.ts` adapts the glue to wire values, so callers cannot tell which
kind they are calling.

A component may import capabilities (FORG-36): `examples/pricing`'s `PriceCart` reads a `Product`
per item. The harness transpiles such a component in jco's JSPI mode, so its synchronous import
call suspends while the host's handle awaits (D1 and the like). The handles come from a `host.js`
module (`bindUnit(..., { host })`; `D1_RESOURCE_HOST` reads a D1 table), and the js-module binding
uses the same handles. A unit's interface hash covers the types its capabilities reach.

Results: `research/composable-units/t2-units/` (acme), `research/composable-units/t5-wasm-unit/` and
`research/composable-units/r2-wasm-async/`.
