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

Each sealed unit carries `sources` (FORG-33): the `.forge` declaration span forgec planned (an
operation's is its resource's; an external's lives in the package that exports it, named by
`package`) and the `impl/` body span this package finds, each with the file's `git hash-object`
blob hash. Loom can check a manifest against a source snapshot with them. They are provenance: only
`manifestHash` covers them, so moving text around never re-identifies a unit. Sealing refuses a
plan whose `.forge` files changed after forgec planned it (`stale plan`).

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

Results: `research/composable-units/t2-units/` (acme), `research/composable-units/t5-wasm-unit/` and
`research/composable-units/r2-coverage/` (coverage and source spans).
