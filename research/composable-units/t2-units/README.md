# T2: unit extraction and Closure Manifest for examples/acme

Research spike for FORG-28 (epic FORG-26). Design: [composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html).
Nothing here changes `app.json` or any other existing build output. The new output appears only
with `forgec build --units`.

## Reproduce

```sh
cargo build -p forgegraph-cli
pnpm install --frozen-lockfile
node research/composable-units/t2-units/measure.ts   # writes results.json and manifest.acme.json
pnpm --filter @forgegraph/units test                 # reproducibility and hash tests
cargo test -p forgegraph-planner --test units        # interface-hash tests
```

`results.json` holds every measured number below. `manifest.acme.json` is the sealed manifest
for acme at this commit. Numbers come from one macOS arm64 machine using forgec 0.5.0 (debug
build), esbuild 0.27.7 and Node 24.14.0.

## What was built

| piece | where | why there |
| --- | --- | --- |
| unit planner | `crates/forgegraph-planner/src/units.rs`, `forgec build --units` → `generated/units/plan.json` | Everything that comes from DomainIR: unit boundaries, interface hashes, capability imports, bindings, entry points, and implementation digests for forge-native units. The compiler stays free of a JS toolchain and filesystem-agnostic. |
| bundler + sealer | `packages/units` (private), `node packages/units/src/cli.ts <app>` → `manifest.json` and `modules/<sha256>.js` | Everything that needs `impl/` bytes. esbuild is already the repo's bundler (`deploy/*/bundle.mjs`). It locates bodies statically with the TypeScript AST and never runs `impl/`. |
| schema | `schemas/closure-manifest.schema.json` | Same conventions as `dependency-grant.schema.json`: draft 2020-12, `sha256:` digests, `additionalProperties: false`. |

One command for acme: `pnpm --filter @acme/commerce-deploy units:build`.

### Identity

- `interfaceHash` = H(`forge:unit-interface:`, canonical interface). The interface holds the symbol,
  input, output, sorted errors, effects (sends, workflow waits), required capabilities, purpose,
  and the transitive closure of every named type the signature reaches. Shapes, enums, the
  fields of `X.Record`, lifecycle states and channel messages are expanded. References stay ids.
  `doc` is removed everywhere. Routes, SLOs, `generated` and the unit's role are left out.
- `implementationHash` = H(`forge:unit-impl:`, implementation). A js-module implementation is
  {module blob sha256, export, ABI, shared library versions}. A forge-native implementation is
  {declaration digest, executor `@forgegraph/runtime@x`}.
- `unitHash` = H(`forge:unit:`, {interface, implementation, sorted dependency unitHashes}).
- `manifestHash` = H(`forge:closure-manifest:`, manifest without `manifestHash`).
- `kind` does not enter any of these digests.

### Tests

- `crates/forgegraph-planner/tests/units.rs`: an acme unit-set snapshot, a deterministic plan, and
  hash behaviour. Edits to docs, the route or a rule leave `interfaceHash` unchanged (a rule does
  move the operation's implementation digest). Adding an error, changing an input-shape field
  (reached transitively, so it also moves the workflow sharing the shape) or changing a
  capability each move `interfaceHash`. Changing a workflow graph (`sleep 5s` → `10s`) moves
  only the implementation.
- `packages/units/test/units.test.ts`, end to end through the real `forgec` binary on scratch copies
  of acme:
  - Two builds in different temp directories produce byte-identical `manifest.json` and
    `modules/*`.
  - Editing an impl body changes `unitHash` and `implementationHash` but not `interfaceHash`. The
    change reaches the workflow that calls the unit and no unrelated unit.
  - Adding an error to the `.forge` signature changes `interfaceHash` and `unitHash`, and leaves
    `implementationHash` unchanged.
  - The manifest validates against the schema, a missing body fails at seal time, and each
    route's closure is checked.

## Results

### Measured

| | value |
| --- | --- |
| units | **56**: 51 resource operations (forge-native), 3 functions (js-module), 1 external binding (js-module, `@acme/payments/_/AuthorizePayment`), 1 workflow (forge-native) |
| JS modules | 4 (one per js-module unit, no sharing) |
| entry points | 64: 55 HTTP routes, 1 queue consumer, 2 crons (one schedule plus the host sweep), 1 workflow class, 4 workflow steps, 1 Durable Object class |
| served by the runtime alone (no root unit) | 4: the `*/5` outbox/workflow sweep, the `ForgeRealtime` DO, workflow status and cancel routes |
| closure size (units per rooted entry point) | min 1, median 1, max 7 (`ProcessOrder` start, its signal route, the workflow class) |
| unit plan / manifest | 404,080 B / 119,883 B |
| plan + seal time | 280 ms (debug forgec, including the normal build) + 27 ms (bundle 4 units and seal) |
| reproducibility | byte-identical across two builds in different directories (test), and across two seals in one process |

Unit module sizes compared with the whole app (bytes; minified / minified+gzip -9):

| unit | own module | same module with runtime + Effect inlined |
| --- | --- | --- |
| FulfillOrder | 231 / 191 | 85,488 / 29,901 |
| RebuildOrderSummary | 183 / 165 | 85,442 / 29,877 |
| SubmitOrder | 717 / 419 | 85,970 / 30,122 |
| AuthorizePayment | 331 / 255 | 329 / 254 (imports nothing) |
| **all impl/ in one module** | 1,465 / 680 | |
| **whole Cloudflare Worker** (`deploy/cloudflare/worker.ts`) | 534,658 / 113,844 | of which app.json 233,015, runtime 207,686, Effect 92,421, impl 1,178 bytes in output |

The four unit modules together (1,462 B minified) are the same size as the impl-only bundle
(1,465 B), so splitting adds no measurable overhead. Application code is 0.22% of the Worker
(1,178 / 534,658).

### Estimated (not measured)

- A packed per-entry-point Worker (Linker A) would still be close to ~85 KB minified per isolate
  for the shared libraries, plus whatever part of `app.json` its forge-native units need. Unit
  code would not drive the size. This adds up the measured parts. No such Worker was built.
- Splitting units saves bytes only if the libraries and the model are shared (a host Worker or
  Dynamic Worker Loader modules) or sliced per closure. That is a T3/T4 question.

## Findings

### Raw env and provider APIs

- **acme impl/ code uses no raw env, `fetch`, platform module or provider SDK.** Every unit gets
  its authority through `FunctionContext` (`deps.resources`, `deps.transitions`, `deps.external`,
  `deps.send`, `deps.fail`), and the runtime already builds exactly the declared dependencies.
  For impl code, "capability handles, never raw env" already holds. The linker would have to
  build those handles per unit instead of per Worker.
- One finding: `impl/payment-adapter.ts` calls `Math.random()` (rule `nondeterminism`), so
  `AuthorizePayment` is not replay-deterministic. It needs an id/random capability; the runtime
  already has an `IdGen` service.
- Env enters only through the runtime host (`packages/runtime/src/hosts/cloudflare.ts`): `DB`,
  `CURSOR_SECRET`, `REALTIME`, `BLOBS`, `FORGE_AUTH`, `FORGE_CORS`, plus `Q_*` producers looked up
  by name. Bindings are recorded per unit and per entry point, derived from capabilities. Host
  bindings (`DB`, `CURSOR_SECRET`, `FORGE_AUTH`) are listed separately because the host builds
  storage for every request.
- The `Q_<SUBSCRIPTION>` naming rule is copied from the runtime host into the planner. If one
  changes and the other doesn't, they drift; the rule should live in one place (the planner's
  messaging plan).

### Where unit boundaries were unclear

1. **Generated operations make up 51 of the 56 units.** They have no `impl/` code: the runtime
   executes the resource declaration. I put the record fields and the operation's
   transition/query declaration in the interface, and the whole resource declaration (rules,
   uniques, decorators) in the implementation. As a result, a rule edit gives every operation of
   that resource (7–11 units) a new identity at once. One unit per resource would be just as
   defensible.
2. **Resource capabilities and the operation units.** `Order read` is satisfied by the runtime
   resource store. Internally that store goes through the generated `get`/`find`/`list` handlers
   (`engine.callInternal`). I did not make those operations dependencies, because every reader's
   closure would then include every query on the resource.
3. **Transitions are both a capability and a unit.** `SubmitOrder` imports
   `transition:Order.status.submit`, provided by the `Order.status.submit` unit, which is in its
   closure.
4. **External bindings cross packages.** `AuthorizePayment` takes its interface from
   `@acme/payments`' IR and its body from acme's `impl/`. Which package owns the unit? Today the
   deployment does.
5. **Workflows.** Steps that call units become `workflow-step` entry points rooted at the called
   unit. `sleep`/`wait` are runtime services (`timers`, `signals`). Start and signal routes need
   the full closure. Status and cancel only touch the instance record, so they are rooted at the
   runtime.
6. **Runtime-only entry points.** The sweep cron and the realtime DO run no application code.
   Under Linker B the sweep would have to reach every workflow closure and every queue producer.
7. **Not split yet** (listed in `uncovered`): view `PendingOrders`, projection
   `CustomerOrderSummary`, cache `CurrentSitePolicy`, and the schedule status/tick routes. The
   runtime serves all of them from `app.json`.
8. **Effects of generated operations are not modelled.** Audited resources publish implicit
   `<Resource>.changes` messages and audit rows, but operation interfaces declare
   `effects.sends: []`.
9. **forge-native units need the model.** The runtime executes them from `app.json`, which is
   233 KB, 44% of the Worker. A manifest-driven linker needs either all of `app.json` or a slice
   per closure.
10. **The unit ABI depends on the runtime and Effect.** js-module bodies are `defineFunction`
    results, so the shared library versions are part of the implementation hash. An Effect bump
    gives every js unit a new identity. The runtime's root entry also forces resolution of
    `node:*` and AWS SDK modules, which tree-shake to 0 bytes but must be externalized to bundle
    a unit standalone.

## Open questions (need a decision)

1. **Should dependencies enter `unitHash` by unit hash (the design as written) or by interface
   hash?** With unit hashes, editing a leaf body gives every caller up to the roots a new
   identity. The test shows this: an edit to `RebuildOrderSummary` re-identifies `ProcessOrder`.
   Caller identities then do not survive dependency edits, which works against "link unit
   hashes against interfaces". Hashing dependencies by interface hash, with implementations
   resolved only in the manifest, keeps callers stable.
2. **Should `symbol` be part of the interface?** It is now, so two functions with identical
   signatures have different interface hashes, and a JS↔WASM swap must keep the symbol. Dropping
   it makes the interface purely structural.
3. **Unit = function or a single Loom symbol?** In acme each impl function is one file with one
   export and no shared helpers, so function and symbol coincide; acme cannot tell the two
   apart. Generated code is finer than a symbol: one resource yields 7–11 operation units. A
   package with shared helper modules is needed to decide. Today such a helper would be
   duplicated into every unit that imports it.
4. **Generated operations: one unit per operation or one per resource?** See boundary finding 1.
5. **Target-specific bindings in the manifest.** Bindings are Cloudflare names, so the manifest
   is target-specific. This argues for keeping it a **sibling of `contract.json`**, which is
   target-independent, rather than part of it. A target-neutral manifest would carry logical
   bindings, and each linker would map them.
6. **Who owns an external binding unit:** the package that declares the interface, or the
   deployment that supplies the body?
