# T3: Linker A (packed) for examples/acme

Research spike for FORG-29 (epic FORG-26), stacked on T2 (FORG-28). Design: [composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html).
The linker is `packages/linker-packed`. It reads a sealed Closure Manifest and writes Worker
scripts. Each script holds one closure group's unit modules, a slice of `app.json`, and a thin host
that passes the runtime only the manifest's declared bindings.

## Reproduce

```sh
pnpm install --frozen-lockfile
bash research/composable-units/t3-linker-packed/run.sh
pnpm --filter @forgegraph/linker-packed test         # grouping, slicing, fail-closed, workerd smoke
pnpm --filter @forgegraph/runtime exec vitest run test/host-dispatch.test.ts
```

`run.sh` does the following in order: builds forgec and the runtime, seals acme's manifest, bundles
today's whole-app Worker as the baseline, links `single`, `per-entry-point` and a
`per-entry-point-full` control (the same split with the whole `app.json` everywhere), and runs
`measure.ts` (→ `results/sizes.json`, `results/edits.json`). It then runs the linker differential
(`packages/linker-packed/test/differential.test.ts` → `results/conformance.json`), which serves each
target locally in workerd through Miniflare, one instance per target, and runs every conformance
scenario plus the realtime WebSocket check against it.

Machine and versions: macOS arm64, forgec 0.5.0 (debug), esbuild 0.27.7, Node 24.14.0,
wrangler 4.135.0, miniflare 5.20260918.0-alpha (workerd 1.20260918.1). The compatibility date is
acme's own, `2026-09-01` (from `deploy/cloudflare/wrangler.jsonc`). Every script, the whole-app
baseline included, is bundled with the same esbuild settings: minified, ESM, `cloudflare:*` and
`node:*` external. Sizes are bytes of that bundle and its gzip -9.

## What a link produces

| piece | what it is |
| --- | --- |
| `link.json` | The deployment: manifest hash (`live`), strategy, and for every script its members, closure hashes, units, module digests, slice report, injected/required/unused bindings, `scriptHash` and size. |
| one script per group | `entry.mjs` (generated: imports the host, the slice and the unit modules), `app.slice.json`, `units/<sha256>.js` (byte-identical to the manifest's blobs, re-verified), `wrangler.jsonc` (the app's environment projected onto this script's bindings, with `script_name` for the DO/workflow owners), `worker.js` (the upload). |
| router (split strategies) | Maps (method, path) to a script over service bindings and holds no runtime and no app code (5,234 B). It exists because Cloudflare route patterns can't express a `{param}` segment mid-path or tell methods apart. |
| residual group `forge:residual` | Every runtime surface the manifest does not describe: changesets, imports, admin, views, projections, caches, schedule routes, `/_forge/objects`, `/forge/*` metadata, socket upgrades. The router's fallback. It refuses manifest routes. |
| dispatch owner | The `forge:sweep` group. Sliced scripts never sweep the outbox themselves. They hand the post-commit nudge (and first-sight schedule tracking) to the owner over a `FORGE_DISPATCH` service binding. |

Strategies: `per-entry-point` (one script per entry point, plus the residual) and `single` (one script
for everything, i.e. the whole-app Worker rebuilt from the manifest). After any strategy, Cloudflare
placement folds workflow steps into their workflow class, because a step runs inside
`WorkflowEntrypoint.run`. Adding a strategy means implementing `GroupingStrategy`.

## Results

### Measured

**Script sizes** (`results/sizes.json`)

| | scripts | raw per script (min / median / max) | gzip per script (min / median / max) | whole deploy raw / gzip |
| --- | --- | --- | --- | --- |
| today's whole-app Worker | 1 | 534,986 | 113,964 | 534,986 / 113,964 |
| linker A `single` | 1 | 537,142 | 114,799 | 537,142 / 114,799 |
| linker A `per-entry-point` | 61 + router | 318,819 / 345,508 / 539,571 | 99,346 / 101,191 / 115,013 | 21,200,030 / 6,185,744 |

wrangler's own dry run of today's Worker reports `Total Upload: 1118.31 KiB / gzip: 163.15 KiB`. That
is wrangler's default build, which is not minified, so it is not comparable with the rows above.

What a per-entry-point script is made of (bytes in the minified output):

| script | total | runtime | Effect | app.json | units | host + entry |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /v1/customers` | 318,821 | 207,973 | 92,421 | 16,090 (Customer) | 0 | 2,221 |
| `POST /v1/orders/{order}/submit` | 350,311 | 208,020 | 92,421 | 46,528 (Customer, Order, Site) | 914 | 2,312 |
| `POST /v1/orders/{order}/process` | 357,651 | 208,020 | 92,421 | 53,766 | 992 | 2,336 |
| `forge:residual` (fallback) | 539,571 | 208,020 | 92,421 | 233,009 (whole) | 1,116 | 4,889 |

The runtime and Effect (300 KB) are the same in every script, because `createWorker` pulls in the
whole engine whatever the model contains. Slicing takes `app.json` from 258,265 B to a median of
48,649 B (min 18,280, max 62,101) across the 59 sliced scripts. A script still can't get below about
300 KB.

**Edits** (`results/edits.json`): which scripts change, by `scriptHash`, compared with which entry
points' `closureHash` changed.

| edit | units moved | closure hashes moved | `single` re-uploads | `per-entry-point` re-uploads |
| --- | --- | --- | --- | --- |
| impl body of `RebuildOrderSummary` (T2's edit) | 1 | 5 entry points | 1 script, 537,142 B (114,799 gz) | **6 of 61** scripts, 2,496,501 B (641,314 gz): 4 groups whose closure moved (the cron, the workflow class with its steps, the start and signal routes) + the 2 fallback groups (residual, sweep), which carry every unit |
| doc comment on `Customer` in a `.forge` file | 0 | 0 | 1 script | **61 of 61**, 21,194,918 B |

For the body edit, the scripts that change are exactly the closure-hash set plus the two fallback
groups. Per-entry-point re-uploads 4.6× more bytes than `single`, because each changed script carries
the 300 KB runtime. A `.forge` edit that moves no unit still moves `buildHash` and `digests`, and
every slice keeps both (the runtime reports `buildHash` in `x-forge-build`, honours
`x-forge-if-build`, and logs it in telemetry), so every script changes.

**Link time** (`run.sh` on the machine above): `single` 186 ms, `per-entry-point` 6.0 s for 61
bundles (esbuild, sequential).

**Conformance differential** (`results/conformance.json`): all 15 scenarios (221 steps) plus the
realtime WebSocket check, against each target served locally in workerd.

| target | scripts | local startup | scenarios passed | realtime | unexplained differences from whole-app |
| --- | --- | --- | --- | --- | --- |
| whole-app (today's Worker) | 1 | 344 ms | 15 / 15 | pass | n/a |
| whole-app again (A/A) | 1 | 286 ms | 15 / 15 | pass | 0 |
| `single` | 1 | 320 ms | 15 / 15 | pass | **0** |
| `per-entry-point` (sliced) | 62 | 2,344 ms | 15 / 15 | pass | **0** |
| `per-entry-point-full` (control) | 62 | 3,613 ms | 15 / 15 | pass | **0** |

Scenarios that ran: blobs, changesets, concurrency, csv-import, customer-crud, idempotency,
integrity, limits, messaging (queue delivery to FulfillOrder), pagination, schedules (manual ticks),
site-references, temporal-hierarchy, views-projections-cache (projection fed from the outbox), and
workflows (Cloudflare Workflows in Miniflare). The realtime check is `conformance/test/realtime.test.ts`.
None were skipped. Not exercised: cron triggers firing on their own (the
schedules scenario ticks over HTTP), and anything that needs a deployed account.

How differences are counted: the suite's own comparator (`compareReports`) compares every step.
Differences under its `EXPLAINED_KEYS` (cursors, timestamps, `requestId`) and after a race step
count as explained, as in `pnpm differential`. Differences at a position where today's Worker also
differs from itself in the A/A run (fresh ids and hashes over them: changeset ids, `contentHash`,
`deletedAt`, `dueAt`, `messageId`) count as run-to-run noise (100 positions). One extra rule,
`generated-id-order`, explains a list ordered only by `id` that returns the same records in a
different order. `limits` creates three customers in one changeset in the same millisecond, so
their order follows fresh random ids. The A/A run shows this too. A linker regression at one of the
100 noise positions would be hidden by this method. Each scenario's own assertions are the primary
gate, and they pass on every target.

### Estimated (not measured)

- On Cloudflare, a cold isolate for a per-entry-point script loads ~100 KB gzip instead of ~114 KB.
  The difference is only the `app.json` slice. Script startup is dominated by the shared runtime,
  so cold start should barely change. Local Miniflare startup (above) measures 62 scripts, not one.
- A router hop adds one service-binding call per request (same-thread on Cloudflare). Not
  measured: the local runs give no meaningful latency.

## app.json slicing: outcome

**The runtime runs from a slice for 59 of the 61 per-entry-point scripts.** It passes the same
scenarios with 0 unexplained differences. The linker builds the runtime `Model` from every slice
at link time, so a slice the runtime would refuse fails the link.

What a group needs is the reachability closure, over declaration ids in `ir`, of:

- the resource of each operation unit, each function and workflow unit, the schedule, queue
  subscription or realtime streams the group serves;
- the **runtime's implicit reads, which no unit declares**:
  - **reference checks.** A create or update validates every reference, so `Order.create` needs
    Customer and Site. The walk follows any declaration id a kept declaration mentions.
  - **restrict-delete.** `dependentsOf` reads every resource that points at the deleted one, so
    `Customer.delete` needs Site, Order and Department.

Sections are then filtered to the kept declarations: `contracts`, `sql.tables`, `observability`,
`messaging`, `workflows`, `schedules`. Channels are kept if kept declarations publish to them
(including `<Resource>.changes`). Only the subscriptions this group consumes are kept. Five sections
are dropped:

- `dynamo`: AWS only.
- `lineage`, `dataSemantics`, `capabilities`: never read by the runtime.
- `openapi`, `ui`: served only by `/forge/openapi.json` and `/forge/workspace.json`, which are
  residual routes.

**Fallbacks (2 of 61), and exactly why:**

1. `forge:residual`. Changesets, imports, admin, views, projections, caches and the schedule routes
   are not in the manifest (`uncovered`, plus runtime surfaces T2 does not list). Changesets can call
   any operation, so there is no closure to slice to. **The runtime needs** these surfaces planned
   as entry points with closures. The changeset closure is "every operation the changeset may name",
   which is the whole app unless the contract narrows it.
2. `forge:sweep`. It delivers every outbox row to every subscription and resumes every workflow (T2
   finding 6), so it needs the whole subscription table and every workflow closure.

**The runtime also needed one change to run from a slice at all** (`hosts/cloudflare.ts`, additive):

- The dispatcher delivers a row to the subscriptions its model knows, then marks the row done. A
  sliced Worker sweeping in-process therefore drops deliveries silently.
  `packages/runtime/test/host-dispatch.test.ts` shows it: a model without the projection leaves the
  `Order.changes` row `delivered` with `delivered: []`, so `CustomerOrderSummary` never sees the
  order.
- New `WorkerOptions.postCommit` replaces the in-process nudge. New `createWorker().dispatch(env,
  tenant, { sweep })` runs it on a whole-table Worker. New `WorkerOptions.sweeps` limits a cron
  invocation to the parts the script owns (a schedule's script runs only the schedule).
- With no options set, behaviour is unchanged.

## Fail closed

All of these are `LinkError`s at link time (`packages/linker-packed/test/link.test.ts`, 9 cases):

| failure | code |
| --- | --- |
| manifest content ≠ `manifestHash` | `manifest-hash` |
| module blob missing | `missing-module` |
| module bytes ≠ digest | `module-hash` |
| unit missing from the manifest | `missing-unit` |
| an import provided by a unit outside the closure | `unprovided-capability` |
| the model grants a unit a capability (e.g. `Site#read`) its manifest imports lack | `undeclared-capability` |
| a module finding that bypasses handles (`raw-env`, `raw-network`, `platform-module`, `global-scope`) | `undeclared-capability` |
| a blob route without `BLOBS` | `undeclared-binding` |
| a workflow without its driver binding | `undeclared-binding` |

The last two matter because the runtime itself fails open there. Without `BLOBS` it silently uses an
in-memory object store. Without the workflow binding it silently falls back to the cron timer.

At request time, each script's env holds only its declared bindings, plus `FORGE_DISPATCH` for
sliced scripts. The runtime inside also gets a refusing stub for each handle (`r2`, queue producer,
workflow) the manifest declares for other scripts (`withheld` in `link.json`). If a request reaches
one anyway, it fails with 403 `CapabilityDenied` (`binding:<type>:<name>`) instead of the silent
fallbacks above (FORG-34, `packages/linker-packed/test/host.test.ts`). A script refuses routes that are not its own (`404 NotRouted`), and the residual
refuses manifest routes. The workerd smoke test checks both.

## Findings

1. **A sliced script can't go much below ~300 KB.** `createWorker` imports the whole engine, so the
   runtime plus Effect are 300 KB of every script, and the median per-entry-point script is 65% of
   the whole-app Worker. Per-entry-point packing multiplies total deploy size by ~40 (21.2 MB vs
   0.54 MB raw) and re-uploads more bytes per body edit than `single` (2.50 MB vs 0.54 MB). Linker A
   only pays off per entry point if the runtime tree-shakes by feature, or if the runtime is shared
   (that is linker B's premise).
2. **`buildHash` and `digests` make every script change on any `.forge` edit,** including a doc
   comment. Either the slice carries a per-closure identity instead, or `x-forge-build` semantics move
   to the router.
3. **The router is required on Cloudflare** for per-route scripts. Routes can't express `{param}`
   mid-path or split by method. It had to buffer request bodies: when a callee answers before reading
   the body (the `blobs` scenario's 413), the client's keep-alive connection broke across the hop.
   This failed 2 of 3 runs before the fix and 0 after. The cost is that uploads through the router
   are not streamed.
4. **The manifest under-declares what the runtime does.**
   - The cancel route declares no `WF_PROCESS_ORDER`, but cancelling wakes the native instance
     (`workflows.ts:263`). The linker reports this as a warning.
   - `FORGE_CORS` is read by the host but is in no `hostBindings`, so packed scripts don't get it
     (fail closed: no CORS).
   - Implicit reads (reference checks, restrict-delete) are not imports. The slicer adds the
     declarations but grants nothing.
   - SubmitOrder's declared `Q_FULFILL_ORDER`/`REALTIME` are only used by dispatch, so a sliced
     script never needs them. They are reported as `unused`.
5. **Deploy is not yet an atomic pointer flip.** Script names are stable per group, so uploading
   changed scripts makes each live as it lands. `link.json`'s `live` is the manifest hash, but nothing
   on the platform holds it. An atomic flip needs content-addressed script names with the router as
   the pointer, or Workers versions/gradual deployments.

## Open questions (need a decision)

1. **Deploy pointer:** content-address script names (`<group>-<scriptHash>`) and make the router
   upload the flip, accepting old-script garbage collection and the per-account script count? Or
   use Workers versions per script and accept a non-atomic cut-over?
2. **Should the runtime split by feature** (HTTP CRUD engine, workflows, schedules, readmodels,
   realtime) so a packed script imports only what its slice uses? Without that, per-entry-point
   packing costs more than it saves.
3. **`buildHash` in slices:** keep it (clients use `x-forge-if-build` for compatibility checks) or
   replace it per script with the group's closure identity?
4. **The planner should own entry points for the residual surfaces** (views, projections, caches,
   schedule routes, changesets, imports) and for the dispatch owner. Until it does, two groups always
   run the whole app.
5. **Grouping beyond these two strategies:** one script per resource (all CRUD routes on Customer
   share a slice) would cut 61 scripts to about 15 with nearly the same slices. Is per-resource the
   next strategy to measure, or does T4 make packing granularity moot?
