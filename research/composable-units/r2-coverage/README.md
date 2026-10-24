# R2: manifest coverage gaps and source spans (FORG-33)

Follow-up to T2 ([FORG-28](../t2-units/README.md)), T3 ([FORG-29](../t3-linker-packed/README.md)) and
T4 ([FORG-30](../t4-linker-dynamic/README.md)). Design: [composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html).
T3 and T4 found that the T2 manifest left runtime surfaces without entry points, so each linker
kept a whole-app fallback. This change closes those gaps, gives the sweep a real closure, and records
source spans so Loom can check a manifest against a snapshot.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm -r run build
bash research/composable-units/r2-coverage/run.sh
```

`run.sh` runs `measure.ts` (coverage before/after and a check of every span → `results/coverage.json`),
T3's full run with `LINK_RESULTS` pointing at `results/linker-packed/` (sizes, edits, the five-target
workerd differential), and `conformance-dynamic.ts` (T4's conformance differential →
`results/linker-dynamic.json`). `results/baseline-main.json` summarizes the manifest sealed on main
0f8a3e4 before this change; it is kept rather than regenerated because it needs the old compiler.
Machine: macOS arm64 (Apple M2 Max), Node 24.14.0, forgec 0.5.0 debug, the wrangler/workerd/miniflare
versions in `pnpm-lock.yaml`. Everything ran locally; nothing was deployed.

## What changed

| | before (main) | after |
| --- | --- | --- |
| units | 56: 51 operation, 3 function, 1 external, 1 workflow | **65**: + 1 view, 1 projection, 1 cache, 1 schedule, 5 service |
| entry points | 64 (55 http-route) | **91** (81 http-route, + 1 `subscription`) |
| `uncovered` | 4: view, projection, cache, schedule routes (changesets and imports missing even from this list) | **none** |
| served by the runtime alone (root null) | 4: sweep, realtime object, workflow status, cancel | 10: realtime object, workflow status and cancel, schedule status, 3 contract-metadata routes, object bytes GET/PUT, realtime upgrade. The sweep now has a root. |
| cancel route bindings | none | `WF_PROCESS_ORDER` |
| host bindings | `DB`, `CURSOR_SECRET`, `FORGE_AUTH` | + `FORGE_CORS` |
| units with source spans | 0 | 60 of 65 (all but the 5 runtime services): 60 declaration spans, 4 body spans; all 64 blob hashes equal `git hash-object` |

### New units and entry points (`crates/forgegraph-planner/src/units.rs`)

- **Read models and schedules** are forge-native units that execute their declaration, with the
  generated operations the runtime calls through `engine.callInternal` as dependencies:
  - `PendingOrders` (view) → `Order.list.byCustomer`;
  - `CustomerOrderSummary` (projection) → `Order.list.all` (rebuild), plus `Order#read` (apply);
  - `CurrentSitePolicy` (cache) → `SitePolicy.effective.bySite`;
  - `NightlyReconciliation` (schedule) → `RebuildOrderSummary`.

  Their routes (`/v1/views/…`, the projection's `status`/`rebuild`/`{id}`, `/v1/caches/…`) are
  rooted at them. A declaration the runtime cannot execute as planned (a view with no matching
  list, a cache whose loader is not `<Resource>.effective`) stays in `uncovered` with the reason.
- **Runtime-service units** (`role: service`): the runtime implements them (the executor version
  pins the code), and the planner owns what each may reach. Their symbols follow the runtime's own
  operation ids:
  - `changesets`: every operation of every resource without credential fields;
  - `imports`: `changesets` plus reads of the stageable resources;
  - `admin`: all four storage modes on every resource, plus every list operation;
  - `schedules`: every schedule unit. The runtime's tick runs every source, so the tick route roots here.
  - `dispatch`: every projection, workflow and the scheduler, and `deliver:` imports for every
    queue subscription and realtime stream.
- **The sweep** (`forge:sweep`) is rooted at `dispatch`, keeping `runtimeService:
  outbox-and-workflow-sweep`. Its closure is everything the outbox sweep, the workflow sweep and
  the schedule sweep can run. That is not the whole app: it excludes, for example, CRUD on Customer,
  Site and Department.
- **The implicit `<Resource>.changes` channel.**
  - Operations of `@audited` resources import `send:<Resource>.changes#<Created|Updated|Deleted|Restored|Transitioned>`
    and declare it in `effects.sends` (T2 finding 8). This moves those operations' interface hashes once.
  - The projection's consumer is an entry point of the new kind `subscription`
    (`projection:CustomerOrderSummary`, `delivery: in-process`), rooted at the projection.
- **Runtime-served routes** get entry points with root null and a `runtimeService`:
  - `schedule-status`;
  - `contract-metadata` (`/forge/discovery`, `openapi.json`, `workspace.json`);
  - `object-bytes` (`/_forge/objects/{token}`, GET and PUT, `BLOBS`);
  - `realtime-upgrade` (`/v1/live/orders`, `REALTIME`).

  The workflow cancel route now declares the workflow binding, because cancelling wakes the native
  instance.

## Linker A (packed): fallback count

Per-entry-point link of acme (`results/linker-packed/sizes.json`):

| | T3 (main) | R2 |
| --- | --- | --- |
| scripts | 61 + router | 87 + router |
| whole-app `fallback` scripts | **2** (`forge:residual`, `forge:sweep`) | **0** |
| `whole` scripts (by design) | — | 3: the contract-metadata routes |
| sliced scripts | 59 | 84; `app.json` slice min / median / max 5,671 / 49,768 / 85,528 B |
| residual | whole app (539,571 B) | empty slice, no units (313,468 B): authenticates and answers 404 |
| sweep (dispatch owner) | whole app | sliced: 63,594 B of `app.json`, 361,745 B script |
| link warnings | 1 (cancel route has no workflow binding) | 0 |

The three `whole` scripts serve the contract itself. Discovery counts the whole model, and the
OpenAPI and workspace documents are the whole contract, so the whole model is their content rather
than a missing closure. They run no units and only read. `fallback` remains only for a manifest that
still lists `uncovered` surfaces, or a sweep with no root (a manifest sealed before FORG-33). The
linker labels it and the tests cover it.

The impl-body edit from T2/T3 (`RebuildOrderSummary`) re-uploads **6 of 87** scripts, all of them
groups whose closure moved: the cron, the tick route, the workflow class with its steps, the start
and signal routes, and the sweep. In T3, 2 of the 6 were the whole-app fallbacks, which moved with
any unit. A `.forge` doc edit still re-uploads every script, because `buildHash` is in every slice
(T3 finding 2, unchanged).

New link-time and request-time behaviour (`packages/linker-packed`):

- The sweep's group is the dispatch owner and sweeps locally. Every other group forwards. The link
  is refused (`slice`) if the owner's slice would lack any subscriber of the full app (projection,
  workflow, schedule, queue subscription, realtime stream). Missing one would drop deliveries
  silently (T3).
- In-process subscriptions fold into the dispatch owner's group, as workflow steps fold into their
  workflow class.
- A method no entry point serves on a known path goes to that path's owner, whose runtime answers
  405 (or a CORS preflight 204). Any other method another script serves is still refused
  (`NotRouted`). Unknown paths go to the residual, which answers 401 or 404, as the whole-app Worker does.

### Conformance differential (`results/linker-packed/conformance.json`)

All 15 scenarios (221 steps) plus the realtime WebSocket check, one Miniflare instance per target:

| target | scripts | scenarios | realtime | unexplained differences from whole-app |
| --- | --- | --- | --- | --- |
| whole-app | 1 | 15 / 15 | pass | n/a |
| whole-app again (A/A) | 1 | 15 / 15 | pass | 0 (100 run-to-run positions) |
| `single` | 1 | 15 / 15 | pass | **0** |
| `per-entry-point` (sliced, no fallback) | 88 | 15 / 15 | pass | **0** |
| `per-entry-point-full` (control) | 88 | 15 / 15 | pass | **0** |

Counting rules are T3's.

## Linker B (dynamic): strict conformance

Run as T4 ran it (`results/linker-dynamic.json`):

| target | T4 (main) | R2 |
| --- | --- | --- |
| whole-app Worker | 15 / 15 | **15 / 15** (221 steps) |
| Linker B strict | 10 / 15 | **15 / 15**: 0 denials, 0 refusals, 0 fallbacks |
| Linker B with `LINKER_UNCOVERED=runtime` | 15 / 15, 49 requests through the whole-app fallback | **15 / 15**, **0** fallbacks |

No child is privileged: 53 distinct children, `privilegedChildren: []`. The post-commit
`dispatch()` child ran 114 times in the strict run on the sweep entry point's closure
(`isSweepClosure: true`, `privileged: false`), with no gate denial. `scheduled()` uses the same
child. The whole-app child now exists only behind `LINKER_UNCOVERED=runtime` and for pre-FORG-33
manifests.

Still not linked, and still refused fail-closed:

- **The realtime Durable Object.** The upgrade route is an entry point now, but the host answers 501
  `UnlinkedEntryPoint`, as before (T4 finding 9). The conformance scenarios do not cover it.
- **Unknown paths.** They get the linker's 404 `UnknownEntryPoint` rather than the runtime's 401/404,
  because B runs nothing for a path no entry point claims.
- **Wrong method or preflight on a known path.** These run in that path's child (`matchRoute(…, {
  anyMethod: true })`), whose runtime answers 405 or 204 without touching a capability.

### With FORG-34 (merged from main bfee5b2)

The results above were re-measured after merging FORG-34. They are unchanged except for script
sizes: scripts are about 1.7 KB larger with the refusing-stub host. FORG-34 turns a binding declared
for another script into a stub that refuses with 403 `CapabilityDenied`. With the fuller
declarations in this change:

- The cancel route holds the real `WF_PROCESS_ORDER`. On main it was undeclared, so it would have
  been a stub, and the runtime swallows a failed wake.
- The sliced sweep holds `BLOBS` as a stub, because nothing in its closure moves blob bytes.
- No conformance step got a `CapabilityDenied`: 15/15 on every Linker A target, and Linker B strict
  15/15 with 0 denials.

## Source spans and blob hashes: design

Each sealed unit has `sources`, the declaration first and then the body:

- **`.forge` declaration.**
  - forgec takes it from the compilation's `source_index`, the same spans the LSP and source map use.
  - A generated operation's declaration is its resource's, because its implementation digest
    covers the whole resource declaration.
  - An external's declaration lives in the package that exports it, so it carries `package:
    "@acme/payments"` and a path relative to that package's root. Dependency sources are threaded
    through `load_tree` (`Loaded::dep_sources`).
- **`impl/` body.** The sealer takes it from the TypeScript AST, as the exported statement
  (`export const x = defineFunction(...)`, or the exported declaration an external binds). For a
  WASM component it is the whole component file.
- **Offsets and blob hash.** `start`/`end` are UTF-8 byte offsets. `gitBlob` is `git hash-object`
  of the whole file: SHA-1 of `blob <len>\0` plus its bytes, computed in Rust (`units::git_blob`,
  the RustCrypto `sha1` crate) and in Node. Tests compare both against `git hash-object`.
- **Runtime-service units** have no source span, because the runtime implements them.

Decisions:

1. **Spans do not enter `implementationHash`, `unitHash` or `closureHash`.** Only `manifestHash`
   covers them.
   - What a unit runs is already pinned: the declaration digest for forge-native units (DomainIR
     carries no locations and `doc` is stripped), and the bundled module's bytes for js-module units.
   - A span moves when unrelated text above it changes, and a blob hash moves with any edit anywhere
     in the file, including another declaration's doc comment. Hashing either would re-identify
     units whose behaviour is unchanged, cold-start their isolates under Linker B and re-upload their
     scripts under Linker A. That would undo T2's rule that identity follows behaviour.
   - Covering spans with `manifestHash` means a sealed span cannot be altered unnoticed. A
     source-only edit changes the manifest and nothing else, much as `buildHash` already does.
   - Tests: prefixing `fulfillment.forge` and `impl/submit-order.ts` with a comment shifts every
     span and changes every blob hash and the manifest hash, while every unit hash, implementation
     hash and closure hash stays the same (`packages/units/test/units.test.ts`; Rust:
     `source_spans_locate_declarations_and_never_enter_a_hash`).
2. **`interfaceHash` never sees a span.** Spans live outside `interface`, which is unchanged.
3. **`kind` still enters no digest.** Sources carry no `kind`, and `part` is metadata.
4. **Stale plans are refused.** The sealer recomputes the blob hash of every own-package `.forge`
   span. If a file changed after `forgec build --units` planned it, it refuses with `stale plan`
   rather than seal spans of text that no longer exists. Dependency packages' files are outside the
   app root and are not re-checked there.
5. **Blob per file, not per span.** Loom snapshots are trees of git blobs, so the file's blob hash is
   what Loom can look up directly. The span then locates the declaration in that blob. A hash of the
   span's own bytes would add nothing the blob does not already pin.

Not done: the helper files a js-module bundles (`modules[].sources`) carry no blob hashes.
Acme has none, since each impl file imports only libraries. The module digest pins the bundle, so
Loom can re-bundle and compare.

## Remaining gaps

- The realtime Durable Object under Linker B (above). Cron Triggers firing on their own, and
  anything deployed, were not exercised, as in T3/T4.
- Admin routes are covered (they root at `admin`), but no conformance scenario calls them.
- The contract-metadata scripts are whole-app by design. A per-closure discovery document would
  need a runtime change: discovery reports counts over the whole model.
- Interface hashes of audited operations moved once, because they now declare their
  `<Resource>.changes` sends.
