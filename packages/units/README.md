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

Results for the reference app: `research/composable-units/t2-units/`.
