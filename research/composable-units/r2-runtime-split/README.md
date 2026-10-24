# R2: Split the runtime by feature for packed scripts

Research spike for FORG-37, following [T3, linker A](../t3-linker-packed/README.md) (FORG-29, finding 1
and open question 2). In T3, `createWorker` brought the whole engine and Effect (about 300 KB minified)
into every packed Worker, so linker A's 61 `per-entry-point` scripts were each 320–540 KB. Now a packed
script imports only the runtime features its `app.json` slice uses.

## Reproduce

```sh
pnpm install --frozen-lockfile
bash research/composable-units/r2-runtime-split/run.sh            # measure (results/after.json), summary, differential
pnpm --filter @forgegraph/runtime exec vitest run test/features.test.ts
pnpm --filter @forgegraph/linker-packed test
```

`measure.ts <label>` builds and seals acme, links `single` and `per-entry-point`, and writes
`results/<label>.json`. That file holds per-script sizes, the total deploy size, what a one-body edit
re-uploads, an esbuild-metafile breakdown of five representative scripts, and Effect's floor.
`results/before.json` comes from the same script on main `bfee5b2`, before the split. It predates the `effectFloor` field, which `measure.ts` gained later.
`results/after.json` comes from `b825240`. `compare.ts` writes `results/summary.json`, which sets both
against FORG-29's recorded `../t3-linker-packed/results`. `results/conformance.json` is the linker
differential run on the split.

The bundling is the same as FORG-29: esbuild, minified, ESM, platform neutral, `cloudflare:*` and
`node:*` external, gzip -9. Machine: macOS arm64, Node 24.14.0, esbuild 0.27.7.

## 1. What a packed script imported (before)

Metafile, bytes in the minified output, `before.json` → `representative`:

| script | total | runtime | Effect | app.json slice |
| --- | --- | --- | --- | --- |
| `GET /v1/customers/{id}` (CRUD read) | 320,584 | 209,334 | 92,421 | 16,090 |
| `POST /v1/orders/{order}/submit` (write + outbox) | 352,021 | 209,381 | 92,421 | 46,528 |
| `ProcessOrder` (workflow class + steps) | 359,373 | 209,381 | 92,421 | 53,766 |
| `fulfill-order` (queue consumer) | 350,230 | 209,381 | 92,421 | 45,609 |
| `forge:sweep` (dispatch owner) | 538,605 | 209,381 | 92,421 | 233,009 |

All five carried the same 42 runtime modules. The largest optional ones were:

- workflows 15.7 KB
- read models 10.3 KB
- schedules 7.3 KB
- changesets 6.5 KB
- blobs 5.2 KB (plus R2 3.2 KB and memory objects 1.5 KB)
- portability 5.2 KB
- governance 4.4 KB
- imports 4.2 KB (plus CSV 1.6 KB)
- local dispatch 1.8 KB

The cause was that `Engine` built every feature in its field initialisers, and the Cloudflare host built
the dispatcher, the R2 store and the workflow and realtime drivers on every request. A bundler can't drop
code a constructor reaches.

## 2. Design

**Features are values a host links in.** `@forgegraph/runtime/features` (new subpath) exports one
side-effect-free value per optional feature:

- `changesets`
- `imports`
- `portability`
- `governance`
- `blobs`
- `readModels`
- `workflows`
- `schedules`
- `realtime`
- `dispatch` (local outbox delivery)

It also exports `allFeatures`, `requiredFeatures(model)`, `checkFeatures` and `featuresNamed`. esbuild
keeps exactly the values a bundle names.

**`EngineCore` and `Engine`.** `EngineCore` (engine.ts, the old `Engine` body) links only
`options.features`, kept in a registry.

- `engine.feature(name)` returns the feature or `undefined`.
- The old fields (`engine.workflows`, `engine.changesets`, …) are now getters that throw when the
  feature is not linked.
- An unlinked surface (changesets, imports, admin) answers `MethodNotAllowed`.
- Core: CRUD, decode, scope, gatekeeper, suppression, temporal, telemetry, functions and transactions.
- `Engine extends EngineCore` and links `allFeatures` when `options.features` is unset. `new Engine(...)`
  is unchanged, and a bundle that names only `EngineCore` does not contain `Engine`.

**Fail closed at build time.**

- `requiredFeatures(model)` maps model content to features:
  - workflows: `workflows`
  - sources: `schedules`
  - views, projections or caches: `readModels`
  - websocket channels: `realtime`
  - blob resources: `blobs`, which also brings `governance` (`checkReadable`)
- `imports` also requires `changesets`.
- `EngineCore` and `createWorkerWith` throw when a model uses a feature that is not linked. A slice
  linked with too few features therefore fails when it is built (for linker A, at link time), never on a
  request.

**Small moves that make the split possible.**

- `writesFenced` moves out of `Portability`, so every writer still honours a migration fence without the
  admin feature (tested).
- `sha256` and `stableJson` move to `hashing.ts` (still re-exported from `engine.js`), so feature
  modules don't import the engine.
- `withProjections` and `internalSubscriptions` tolerate missing workflows or realtime.

**The Cloudflare host gets feature variants of its three factories:**

- `createWorkerWith(bundle, { features, objects?, ... })`
- `createWorkflowEntrypointWith`
- `createRealtimeObjectWith`

`createWorker`, `createWorkflowEntrypoint` and `createRealtimeObject` are the same code with
`allFeatures` and `cloudflareObjects` (R2 when `BLOBS` is bound, otherwise memory, as before). Blob
storage becomes a `WorkerObjects` option. Without it, `Objects` refuses every call, and linking `blobs`
without `objects` throws. A Worker without `dispatch` must set `postCommit` and `sweeps.outbox: false`,
because it cannot deliver its outbox.

**Linker A** (`packages/linker-packed/src/features.ts`, plus a few lines in `link.ts` and `host.ts`):

- The generated `entry.mjs` imports exactly `requiredFeatures(sliceModel)`, plus `cloudflareObjects`
  when the slice has blobs, and passes them to `packed()`.
- Fallback groups (`forge:residual`, `forge:sweep`, `single`) import `allFeatures`.
- Sliced scripts forward dispatch, so none of them links `dispatch`.
- At link time the linker builds the Worker with `createWorkerWith(slice, …)` and the script's real
  sweeps and `postCommit` shape. If the runtime refuses, the link fails with `LinkError("slice")`.
- `link.json` records `features` for each script.
- `packed()` requires `features` in its second argument, because the host must not name `allFeatures`
  itself.

Features across the 61 scripts:

| features | scripts |
| --- | --- |
| none | 40 |
| `blobs`, `governance` | 10 |
| `realtime`, `workflows` | 5 |
| `realtime` | 3 |
| `schedules` | 1 |
| all (fallbacks) | 2 |

Options considered and not taken:

- **Lazy `import()` boundaries.** A Worker upload is one bundle, so esbuild inlines a dynamic import
  without code splitting. It defers evaluation but saves no bytes.
- **A feature-derived `createWorker` that keeps the full default.** Any function that falls back to
  `allFeatures` brings in every feature, so the feature path has to be a separate entry
  (`...With`).

## 3. Results (measured)

`results/summary.json`. Raw per script and gzip per script are min / median / max.

| | raw per script | gzip per script | whole deploy raw / gzip |
| --- | --- | --- | --- |
| FORG-29 (T3) | 318,819 / 345,508 / 539,571 | 99,346 / 101,191 / 115,013 | 21,200,030 / 6,185,744 |
| main before split (`bfee5b2`) | 320,576 / 347,265 / 541,215 | 100,046 / 101,893 / 115,656 | 21,306,592 / 6,228,331 |
| **after split (`b825240`)** | **254,206 / 280,895 / 544,493** | **79,688 / 81,537 / 116,353** | **17,645,144 / 5,103,410** |
| change vs FORG-29 | −20.3% / −18.7% / +0.9% | −19.8% / −19.4% / +1.2% | −16.8% / −17.5% |

All rows are for 61 scripts plus the router. The deploy totals include the 5,234 B router.

Runtime plus Effect per script: from 301,755 B in every script to 235,373 B (median) for sliced scripts.
The two fallback scripts carry 305,057 B.

**What a one-body edit re-uploads.** The edit is `impl/rebuild-order-summary.ts`, the same as FORG-29.

| | scripts | raw | gzip |
| --- | --- | --- | --- |
| FORG-29 `per-entry-point` | 6 of 61 | 2,496,501 | 641,314 |
| main before split | 6 of 61 | 2,506,550 | 645,282 |
| **after split** | 6 of 61 | **2,308,463** (−7.5%) | **583,803** (−9.0%) |
| `single` (for reference) | 1 | 542,064 | 116,150 |

The same six scripts change: the four whose closure moved, plus the two fallbacks. The fallbacks are
1.09 MB of the 2.31 MB and did not shrink, so the edit saving is smaller than the per-script saving.

**The representative scripts after the split** (`after.json` → `representative`):

| script | features | total | runtime | Effect | runtime modules | dropped |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /v1/customers/{id}` | none | 254,214 (−20.7%) | 142,995 | 92,378 | 33 | workflows, read models, schedules, changesets, blobs + R2 + memory objects, governance, imports + CSV, dispatch |
| `POST /v1/orders/{order}/submit` | realtime | 287,604 (−18.3%) | 144,993 | 92,378 | 33 | same |
| `ProcessOrder` | realtime, workflows | 310,843 (−13.5%) | 160,877 | 92,378 | 35 | same except workflows; read models drops to the 139 B `durationMs` it imports |
| `fulfill-order` | realtime | 285,813 (−18.4%) | 144,993 | 92,378 | 33 | same as the CRUD read |
| `forge:sweep` | all | 541,883 (+0.6%) | 212,611 | 92,446 | 44 | none |

**The whole-app Worker and the fallbacks grew by 0.6%** (whole app: 536,243 → 539,718 B). That is the
registry, the getters, the feature checks and the `...With` indirection.

### Effect: at its floor

The runtime's Effect share is 92,378 B. Effect's floor, bundled the same way (`after.json` →
`effectFloor`):

- `Effect.runPromise(Effect.succeed(1))` alone is 85,356 B.
- A service provided through a `Layer`, which is what the engine needs, is 91,944 B.

So the runtime uses essentially no Effect beyond its fiber runtime core (`internal/effect.js` is 38 KB of
it). No import discipline will cut it. The only way to get below about 92 KB is to stop running
requests through Effect, which is a different project.

## 4. Correctness

- **Linker differential** (`T3_DIFFERENTIAL=1`, `results/conformance.json`):
  - Scenarios: 15/15 (221 steps) plus the realtime WebSocket check on every target: whole-app,
    whole-app A/A, `single`, `per-entry-point`, `per-entry-point-full`.
  - Unexplained differences from whole-app: 0 on every target. Run-to-run noise is 100 positions, as in
    FORG-29.
  - Local startup times (3.1–18.5 s) are far above FORG-29's because other builds were running on the
    machine. Don't compare them.
- **The whole-app Worker** (`deploy/cloudflare/worker.ts`, which uses `createWorker`) passes 15/15.
- **Runtime tests:** 166 files and 1,087 tests pass (`--testTimeout=60000`), including the new
  `test/features.test.ts`. It covers the full `Engine` and the derived requirements, a refused
  under-linked model, CRUD on a bare `EngineCore`, an unlinked surface answering 405, the fence honoured
  without portability, and the `createWorkerWith` refusals.
- **Other tests:** linker-packed 18/18 (including a new feature-selection case and the workerd smoke
  test), linker-dynamic 29/29, units 18/18.
- **Build and release checks:** `pnpm -r run build`, `pnpm typecheck`, `release:check` and
  `release:identities` pass.

## 5. What still sits in every sliced script, and what's left

The CRUD floor is 254 KB: Effect 92 KB, runtime core 143 KB, slice 16 KB, host 2 KB. The core parts
that still look optional:

| part | bytes | why it stayed |
| --- | --- | --- |
| transactions (`transaction.ts` + the `MemoryStorage` it snapshots into) | 13,875 | A function is transactional through `defineFunction(..., { transactional })` in unit code, so the linker can't tell without evaluating the module. The planner could record it in the manifest. |
| D1 adapter | 20,004 | One class with every storage method (outbox, documents, ledgers). Methods can't be tree-shaken. Splitting it means splitting the `StorageAdapter` interface. |
| api-publication + webhooks + http-endpoints | 7,432 | `createHttpHandler` calls them unconditionally (validation of empty options). They could be injected like features. Not done, to keep `http.ts` stable. |
| `realtime` in sliced scripts | ~2,000 | A slice keeps a websocket channel (`Order.changes`) that its commits publish to, so the model asks for realtime even though fan-out runs in the dispatch owner. |

**Findings**

1. **Splitting by feature cuts a typical packed script by about a fifth** (median raw −18.7%, gzip −19.4%,
   deploy −17%). It does not change T3's conclusion: per-entry-point packing still costs about 33× a
   single Worker in deploy bytes (17.6 MB vs 0.54 MB). The floor is Effect plus the CRUD engine,
   235 KB of every script.
2. **Per-script slicing can't remove Effect.** It is already at its floor.
3. **The fallback groups dominate edits.** Two whole-app scripts are re-uploaded on every body edit. This
   is T3 open question 4: the planner should own entry points for the residual surfaces and for the
   dispatch owner.
4. **Shared code is the bigger lever.** The remaining 235 KB is identical across scripts, so linker B's
   shared-runtime premise (T4), or per-resource grouping (T3 open question 5), cuts more than further
   splitting.

## API compatibility

Additive only. A comparison of runtime export names against `bfee5b2` across every subpath found nothing
removed. Added:

- `.`: `EngineCore`, `writesFenced`
- `./cloudflare`: `createWorkerWith`, `createWorkflowEntrypointWith`, `createRealtimeObjectWith`,
  `cloudflareObjects`
- the new `./features` subpath (14 exports)

`EngineOptions.features` and `WorkerOptions.objects` are new optional fields.

Behaviour is unchanged for `new Engine(...)` and `createWorker`. Two type-level changes on `Engine`:

- The feature members (`changesets`, `blobs`, `imports`, `readModels`, `workflows`, `schedules`,
  `realtime`, `portability`, `governance`) are now read-only accessors on `EngineCore` instead of own
  readonly fields. A subclass can no longer redeclare them as fields.
- They throw when the feature is not linked, which only happens on an `EngineCore` or with an explicit
  `features`.

In `@forgegraph/linker-packed` (private), `packed()` now requires `features` in its second argument.
