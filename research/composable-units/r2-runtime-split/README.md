# R2: Split the runtime by feature for packed scripts

Research spike for FORG-37, following [T3, linker A](../t3-linker-packed/README.md) (FORG-29, finding 1
and open question 2). In T3, `createWorker` brought the whole engine and Effect (about 300 KB minified)
into every packed Worker, so linker A's 61 `per-entry-point` scripts were each 320–540 KB. Now a packed
script imports only the runtime features its `app.json` slice uses.

Merged over main `c0e7558`, which includes FORG-33 (manifest coverage). Since FORG-33 linker A has 87
scripts, the residual and the sweep are sliced, and only the three contract-metadata scripts carry the
whole `app.json`. The baseline for this spike is therefore main `c0e7558` without the split.

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
The results files:

- `results/main-c0e7558.json`: the same script on main `c0e7558` (FORG-33, 87 scripts, no split). This
  is the baseline.
- `results/after.json`: the split merged over `c0e7558` (`760137e`).
- `results/before.json`: main `bfee5b2` (61 scripts, before FORG-33 and the split), kept for context.
  It predates the `effectFloor` field.
- `results/summary.json`: written by `compare.ts`; sets all three against FORG-29's recorded
  `../t3-linker-packed/results`.
- `results/conformance.json`: the linker-A differential on the split (`LINK_RESULTS`).
- `results/linker-dynamic.json`: linker B's strict conformance on the split (FORG-33's
  `r2-coverage/conformance-dynamic.ts`, copied here so FORG-33's record stays as measured).

The bundling is the same as FORG-29: esbuild, minified, ESM, platform neutral, `cloudflare:*` and
`node:*` external, gzip -9. Machine: macOS arm64, Node 24.14.0, esbuild 0.27.7.

## 1. What a packed script imported (before)

Metafile, bytes in the minified output, `before.json` → `representative` (main `bfee5b2`; on `c0e7558`
the runtime and Effect columns are identical, and the sweep is sliced to 361,745 B):

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

- A sliced group links the union of three things:
  - `requiredFeatures` of its slice's model.
  - The features behind the runtime-served routes it answers. `surfaceFeatures(path)` in
    `@forgegraph/runtime/features` maps `/v1/changesets*` to `changesets`, `/v1/imports/*` to `imports`
    (which brings `changesets`), `/v1/admin/{export,import,verify,fence}` to `portability`, and
    `/v1/admin/{subjects/locate,inspect}` to `governance`.
  - `dispatch`, for the dispatch owner only.
- It links blob storage (`cloudflareObjects`) with `blobs`, and for the `/_forge/objects/{token}`
  scripts, which serve bytes without any blob operation.
- Groups that run the whole `app.json` link `allFeatures`: contract metadata (`whole`), a `fallback` for
  an uncovered surface, `single`, and the `per-entry-point-full` control. Contract metadata could be
  linked smaller (it only reads the model), but the model it carries uses every feature, so
  `checkFeatures` would demand most of them anyway. It stays on the full set.
- At link time the linker builds the Worker with `createWorkerWith(slice, …)` and the script's real
  sweeps and `postCommit` shape. If the runtime refuses, the link fails with `LinkError("slice")`.
- `link.json` records `features: { mode, names, objects }` for each script.
- `packed()` requires `features` in its second argument, because the host must not name `allFeatures`
  itself.

**The residual and the sweep, after FORG-33.**

- `forge:residual` has an empty model. It only authenticates and answers 404, so it links no features
  (247,110 B, down from 313,468).
- `forge:sweep` is the dispatch owner, sliced to the dispatch unit's closure. It links `dispatch`,
  `readModels` (the projection), `realtime` (fan-out), `schedules` (its slice holds the sources its cron
  sweeps) and `workflows` (332,830 B, down from 361,745).

Features across the 87 scripts:

| features | scripts |
| --- | --- |
| none (2 of them with blob storage: `GET`/`PUT /_forge/objects/{token}`; 1 is the residual) | 43 |
| `blobs`, `governance` | 12 |
| `blobs`, `changesets`, `governance` (changesets) | 5 |
| `readModels` (views, caches, projection reads) | 5 |
| `realtime`, `workflows` | 5 |
| `blobs`, `governance`, `portability` (admin export, import, verify, fence) | 4 |
| `realtime` | 4 |
| `schedules` | 3 |
| `blobs`, `changesets`, `governance`, `imports` (imports) | 2 |
| `dispatch`, `readModels`, `realtime`, `schedules`, `workflows` (the sweep) | 1 |
| all (contract metadata, the whole `app.json`) | 3 |

The changeset, import and admin slices hold every resource, including the blob resource
`OrderDocument`, so they link `blobs` and `governance` too.

**FORG-34's `CapabilityDenied` with the split.** A withheld binding and a missing feature are two
different things, and both are refused:

- **A withheld binding still answers 403 `CapabilityDenied`.** The packed host still replaces each
  withheld handle with a refusing stub, and blob storage reads `BLOBS` from the narrowed env whichever
  features are linked. So a script with `blobs` linked and `BLOBS` withheld answers 403
  `binding:r2:BLOBS`, exactly as before. `packages/linker-packed/test/host.test.ts` checks this both with
  every feature and with only the slice's features.
- **A missing feature can't reach the binding.**
  - A model that uses blob resources without `blobs` (or `blobs` without blob storage) is refused when
    the Worker is built, which for linker A means at link time.
  - With `blobs` absent, the model has no blob operations, so blob routes answer 404. The withheld stub
    is never reached (tested).
  - If anything still reached blob storage in a Worker linked without it, the `Objects` service refuses
    with 403 `CapabilityDenied` (capability `objects`). That is a linking defect, and it is refused like
    any capability the script isn't linked with. Before this merge it answered 405.
- **An engine surface that isn't linked** (changesets, imports or admin on a script without them)
  answers 405 `MethodNotAllowed`: an operation that isn't served here, not a refused authority. On
  linker-A output the host refuses such routes with 404 `NotRouted` before the engine sees them.

Options considered and not taken:

- **Lazy `import()` boundaries.** A Worker upload is one bundle, so esbuild inlines a dynamic import
  without code splitting. It defers evaluation but saves no bytes.
- **A feature-derived `createWorker` that keeps the full default.** Any function that falls back to
  `allFeatures` brings in every feature, so the feature path has to be a separate entry
  (`...With`).

## 3. Results (measured)

`results/summary.json`. Raw per script and gzip per script are min / median / max. Deploy totals include
the router (5,234 B with 61 scripts, 7,577 B with 87).

| | scripts | raw per script | gzip per script | whole deploy raw / gzip |
| --- | --- | --- | --- | --- |
| FORG-29 (T3) | 61 | 318,819 / 345,508 / 539,571 | 99,346 / 101,191 / 115,013 | 21,200,030 / 6,185,744 |
| main `bfee5b2` (before FORG-33) | 61 | 320,576 / 347,265 / 541,215 | 100,046 / 101,893 / 115,656 | 21,306,592 / 6,228,331 |
| **main `c0e7558` (baseline)** | 87 | 309,772 / 348,583 / 537,742 | 98,677 / 102,220 / 114,953 | 30,877,218 / 8,918,184 |
| **split over `c0e7558`** | 87 | **247,110 / 285,719 / 541,032** | **78,796 / 82,560 / 115,665** | **25,941,622 / 7,400,600** |
| change vs `c0e7558` | | −20.2% / −18.0% / +0.6% | −20.1% / −19.2% / +0.6% | −16.0% / −17.0% |

Runtime plus Effect per script drops from 301,755 B in every script to 235,385 B (min) and 237,383 B
(median). The three contract-metadata scripts carry 305,022 B. The max row is contract metadata in both
columns, which links every feature.

**What a one-body edit re-uploads.** The edit is `impl/rebuild-order-summary.ts`, the same as FORG-29.

| | scripts re-uploaded | raw | gzip |
| --- | --- | --- | --- |
| FORG-29 `per-entry-point` | 6 of 61 | 2,496,501 | 641,314 |
| main `bfee5b2` | 6 of 61 | 2,506,550 | 645,282 |
| **main `c0e7558` (baseline)** | 6 of 87 | 2,138,367 | 621,567 |
| **split** | 6 of 87 | **1,845,816** (−13.7%) | **532,147** (−14.4%) |
| `single` (for reference) | 1 | 542,264 | 116,236 |

FORG-33 removed the whole-app fallbacks from this set. The six scripts are now:

- the cron
- the schedule tick route
- the workflow class
- the start route
- the signal route
- the sweep

Every one of them is sliced, so the split shrinks all six. For example, the workflow class goes from
359,561 to 311,043 B, and the sweep from 361,745 to 332,830 B.

**The representative scripts** (`summary.json` → `representative`, `c0e7558` → split):

| script | features | total | runtime | Effect |
| --- | --- | --- | --- | --- |
| `GET /v1/customers/{id}` (CRUD read) | none | 320,899 → 254,541 (−20.7%) | 209,334 → 143,007 | 92,421 → 92,378 |
| `POST /v1/orders/{order}/submit` (write + outbox) | realtime | 352,257 → 287,852 (−18.3%) | 209,381 → 145,005 | same |
| `ProcessOrder` (workflow class + steps) | realtime, workflows | 359,561 → 311,043 (−13.5%) | 209,381 → 160,889 | same |
| `fulfill-order` (queue consumer) | realtime | 350,418 → 286,013 (−18.4%) | 209,381 → 145,005 | same |
| `forge:sweep` (dispatch owner) | dispatch, readModels, realtime, schedules, workflows | 361,745 → 332,830 (−8.0%) | 209,381 → 180,440 | same |

Other scripts (`c0e7558` → split):

- `forge:residual`: 313,468 → 247,110
- `POST /v1/changesets`: 380,032 → 334,743
- `POST /v1/imports/stage`: 380,041 → 340,746
- `POST /v1/admin/fence`: 380,035 → 333,387
- `GET /v1/views/pending-orders`: 348,630 → 292,201
- `GET /_forge/objects/{token}`: 309,772 → 248,266

What the CRUD read drops: workflows, read models, schedules, changesets, blobs (plus R2 and memory
objects), governance, imports (plus CSV) and dispatch. The workflow script keeps only the 139 B
`durationMs` of `readmodels.ts`.

**The whole-app Worker grew by 0.6%** (536,243 → 539,730 B), and so did contract metadata and `single`.
That is the registry, the getters, the feature checks and the `...With` indirection.

### Effect: at its floor

The runtime's Effect share is 92,378 B. Effect's floor, bundled the same way (`after.json` →
`effectFloor`):

- `Effect.runPromise(Effect.succeed(1))` alone is 85,356 B.
- A service provided through a `Layer`, which is what the engine needs, is 91,944 B.

So the runtime uses essentially no Effect beyond its fiber runtime core (`internal/effect.js` is 38 KB of
it). No import discipline will cut it. The only way to get below about 92 KB is to stop running
requests through Effect, which is a different project.

## 4. Correctness

All of these ran on the merge with `c0e7558`.

- **Linker-A differential** (`T3_DIFFERENTIAL=1`, `LINK_RESULTS` → `results/conformance.json`):
  - Scenarios: 15/15 (221 steps) plus the realtime WebSocket check on every target: whole-app,
    whole-app A/A, `single`, `per-entry-point` (87 scripts + router), `per-entry-point-full`.
  - Unexplained differences from whole-app: 0 on every target. Run-to-run noise is 100 positions, as in
    FORG-29.
- **The whole-app Worker** (`deploy/cloudflare/worker.ts`, which uses `createWorker`) passes 15/15.
- **Linker B** strict conformance (`results/linker-dynamic.json`): whole-app 15/15, strict 15/15 and the
  reported-fallback host 15/15, with 0 denials, 0 fallbacks and 0 refusals. Linker B's children use the
  full `createWorker`, so this checks the whole-engine path after the split.
- **Runtime tests:** 166 files and 1,087 tests pass (`--testTimeout=60000`), including
  `test/features.test.ts`.
- **Other tests:** linker-packed 23 passed (6 opt-in differential cases skipped), including the feature
  selection for FORG-33's groups and the four `CapabilityDenied` host cases. linker-dynamic 30/30,
  units 28/28.
- **Rust:** `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings` and
  `cargo test --workspace` pass.
- **Build and release checks:** `pnpm -r run build`, `pnpm typecheck`, `release:check` and
  `release:identities` pass.
- **Fixtures:** `scripts/refresh-fixtures.sh` leaves the tree clean.

## 5. What still sits in every sliced script, and what's left

The CRUD floor is 255 KB: Effect 92 KB, runtime core 143 KB, slice 16 KB, host 2 KB. The core parts
that still look optional:

| part | bytes | why it stayed |
| --- | --- | --- |
| transactions (`transaction.ts` + the `MemoryStorage` it snapshots into) | 13,875 | A function is transactional through `defineFunction(..., { transactional })` in unit code, so the linker can't tell without evaluating the module. The planner could record it in the manifest. |
| D1 adapter | 20,004 | One class with every storage method (outbox, documents, ledgers). Methods can't be tree-shaken. Splitting it means splitting the `StorageAdapter` interface. |
| api-publication + webhooks + http-endpoints | 7,432 | `createHttpHandler` calls them unconditionally (validation of empty options). They could be injected like features. Not done, to keep `http.ts` stable. |
| `realtime` in sliced scripts | ~2,000 | A slice keeps a websocket channel (`Order.changes`) that its commits publish to, so the model asks for realtime even though fan-out runs in the dispatch owner. |

**Findings**

1. **Splitting by feature cuts a typical packed script by about a fifth** against `c0e7558`: median raw
   −18.0%, gzip −19.2%, deploy −16%. It cuts the bytes a one-body edit re-uploads by 13.7%. It does
   not change T3's conclusion: per-entry-point packing still costs about 48× a single Worker in deploy
   bytes (25.9 MB vs 0.54 MB for 87 scripts). The floor is Effect plus the CRUD engine, about 235 KB of
   every script.
2. **Per-script slicing can't remove Effect.** It is already at its floor.
3. **With FORG-33, edits touch only sliced scripts,** so the split now reaches every re-uploaded byte. The
   only whole-`app.json` scripts left are contract metadata, which changes on any `.forge` edit anyway.
4. **Shared code is the bigger lever.** The remaining ~235 KB is identical across scripts, so linker B's
   shared-runtime premise (T4), or per-resource grouping (T3 open question 5), cuts more than further
   splitting.

## API compatibility

Additive only. A comparison of runtime export names against `bfee5b2` across every subpath found nothing
removed. Added:

- `.`: `EngineCore`, `writesFenced`
- `./cloudflare`: `createWorkerWith`, `createWorkflowEntrypointWith`, `createRealtimeObjectWith`,
  `cloudflareObjects`
- the new `./features` subpath (15 exports, including `surfaceFeatures`)

`EngineOptions.features` and `WorkerOptions.objects` are new optional fields. A Worker built with
`createWorkerWith` and no blob storage refuses `Objects` calls with 403 `CapabilityDenied`. `createWorker`
always has blob storage.

Behaviour is unchanged for `new Engine(...)` and `createWorker`. Two type-level changes on `Engine`:

- The feature members (`changesets`, `blobs`, `imports`, `readModels`, `workflows`, `schedules`,
  `realtime`, `portability`, `governance`) are now read-only accessors on `EngineCore` instead of own
  readonly fields. A subclass can no longer redeclare them as fields.
- They throw when the feature is not linked, which only happens on an `EngineCore` or with an explicit
  `features`.

In `@forgegraph/linker-packed` (private), `packed()` now requires `features` in its second argument.
