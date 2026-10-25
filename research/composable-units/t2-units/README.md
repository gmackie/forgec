# T2: unit extraction and Closure Manifest for examples/acme

Research spike for FORG-28 (epic FORG-26). Design: [composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html).
Nothing here changes `app.json` or any other existing build output. The new output appears only
with `forgec build --units`.

> **Addendum (FORG-33, 2026-10-24).** Boundary findings 5–8, the `uncovered` list and the
> runtime-only entry points below are superseded: the planner now covers every surface the runtime
> serves (`uncovered` is empty for acme), operations of `@audited` resources declare their
> `<Resource>.changes` sends, and every unit records its `.forge` declaration and `impl/` body span
> with git blob hashes. The numbers in this README are T2's record and were not re-measured here.
> See [`../r2-coverage/`](../r2-coverage/README.md).

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

- `interfaceHash` = H(`forge:unit-interface:`, canonical interface). The interface is structural.
  It holds the input, output, sorted errors, effects (sends, workflow waits), required capabilities, purpose,
  and the transitive closure of every named type the signature reaches. A function whose errors
  declare a non-default HTTP status (`Name status 422`, FORG-44) also carries `errorStatuses`
  (name → status). The status is observable to callers, so changing it moves `interfaceHash`.
  Errors that keep the 409 default add nothing, so existing interface hashes stay the same. Shapes, enums, the
  fields of `X.Record`, lifecycle states and channel messages are expanded. References stay ids.
  `doc` is removed everywhere. The symbol, routes, SLOs, `generated` and the unit's role are left
  out, so two units of the same shape share an interface hash. The symbol stays in the manifest as
  the binding name.
- `implementationHash` = H(`forge:unit-impl:`, implementation). A js-module implementation is
  {module blob sha256, export, ABI, shared library versions}. A forge-native implementation is
  {declaration digest, executor `@forgegraph/runtime@x`}.
- `unitHash` = H(`forge:unit:`, {interface, implementation, sorted dependency *interface* hashes}).
  A body edit re-identifies only the edited unit, not its callers.
- `closureHash` = H(`forge:closure:`, sorted unit hashes of an entry point's closure). It pins the
  exact implementations an entry point runs, so it changes whenever any of them changes.
- `manifestHash` = H(`forge:closure-manifest:`, manifest without `manifestHash`).
- `kind` does not enter any of these digests.

### Tests

- `crates/forgegraph-planner/tests/units.rs`: an acme unit-set snapshot, a deterministic plan, and
  hash behaviour. Edits to docs, the route or a rule leave `interfaceHash` unchanged (a rule does
  move the operation's implementation digest). Adding an error, changing an input-shape field
  (reached transitively, so it also moves the workflow sharing the shape) or changing a
  capability each move `interfaceHash`. Changing a workflow graph (`sleep 5s` → `10s`) moves
  only the implementation. Two functions with identical signatures and different names share an
  interface hash.
- `packages/units/test/units.test.ts`, end to end through the real `forgec` binary on scratch copies
  of acme:
  - Two builds in different temp directories produce byte-identical `manifest.json` and
    `modules/*`.
  - Editing an impl body changes that unit's `unitHash` and `implementationHash` but not its
    `interfaceHash`. No other unit hash moves; `ProcessOrder`, which calls it, keeps its own. The
    `closureHash` of exactly the 5 entry points whose closure contains the unit changes (the cron,
    the workflow step, the workflow class, and its start and signal routes).
  - Adding an error to the `.forge` signature changes `interfaceHash` and `unitHash`, and leaves
    `implementationHash` unchanged. The calling workflow's `unitHash` moves with it.
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
| unit plan / manifest | 400,919 B / 126,027 B |
| plan + seal time | 274 ms (debug forgec, including the normal build) + 30 ms (bundle 4 units and seal) |
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

## Decided

- **Dependencies enter `unitHash` by interface hash.** Under the original rule (dependency unit
  hashes) a leaf body edit re-identified every caller up to the roots; the first version of this
  spike showed an edit to `RebuildOrderSummary` re-identifying `ProcessOrder`. Exact
  implementations are now pinned per entry point by `closureHash` (and by `buildHash`).
- **`symbol` is not part of the interface.** Interfaces are structural, so a JS unit can be
  swapped for a WASM unit of the same shape under the same binding name.
- Because unit identity no longer depends on dependency identities, a dependency cycle now has
  well-defined hashes and is no longer refused. Closures handle cycles.
- With structural interfaces, two units can in principle hash identically (same shape, same
  body, same dependency interfaces). The manifest keys units by hash, so the sealer refuses that
  case with an explicit error rather than silently dropping one symbol. acme has no such pair.

## Open questions (need a decision)

1. **Type closure keys are still nominal.** Named shapes and enums are keyed by their stable id
   in the interface's type closure, so two structurally equal shapes with different names still
   give different interfaces. Should named types be fully structural too?
2. **Unit = function or a single Loom symbol?** In acme each impl function is one file with one
   export and no shared helpers, so function and symbol coincide; acme cannot tell the two
   apart. Generated code is finer than a symbol: one resource yields 7–11 operation units. A
   package with shared helper modules is needed to decide. Today such a helper would be
   duplicated into every unit that imports it.
3. **Generated operations: one unit per operation or one per resource?** See boundary finding 1.
4. **Target-specific bindings in the manifest.** Bindings are Cloudflare names, so the manifest
   is target-specific. This argues for keeping it a **sibling of `contract.json`**, which is
   target-independent, rather than part of it. A target-neutral manifest would carry logical
   bindings, and each linker would map them.
5. **Who owns an external binding unit:** the package that declares the interface, or the
   deployment that supplies the body?
