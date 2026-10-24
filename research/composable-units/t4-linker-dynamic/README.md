# T4: Linker B, Closure Manifests on the Dynamic Worker Loader

Research spike T4 of the composable-units epic ([FORG-26](https://tasks.gmac.io/gmacko/issue/FORG-26)); this task is [FORG-30](https://tasks.gmac.io/gmacko/issue/FORG-30). Design: [composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html). Stacked on T2 ([FORG-28](https://tasks.gmac.io/gmacko/issue/FORG-28), `research/composable-units/t2-units/`).

One host Worker serves `examples/acme` from its sealed Closure Manifest. For each request it resolves the entry point, derives the closure's capability policy, and runs the closure in a child isolate from the Dynamic Worker Loader (`env.LOADER.get(id, cb)`). Children are cached by closure hash. A child gets capability stubs and the manifest's host vars only, never the host's `env`, and has no network unless its entry point declares egress.

Everything here ran on local workerd (`wrangler dev --local`). Nothing was deployed.

## Reproduce

Requires the T2 prerequisites (`cargo build -p forgegraph-cli`, `pnpm install`) and the workspace build (`pnpm -r run build`, for the runtime's `dist/`, which the whole-app baseline Worker imports). From the repository root:

```sh
pnpm --filter @forgegraph/linker-dynamic build     # shared libraries -> packages/linker-dynamic/generated/libs
pnpm --filter @forgegraph/linker-dynamic test      # resolve/policy/gate tests + the host under wrangler dev --local
RUNS=30 node research/composable-units/t4-linker-dynamic/measure.ts   # results.json + conformance/*.json
```

`measure.ts` re-runs `units:build` for acme, starts the host and today's whole-app Worker (`examples/acme/deploy/cloudflare`) in turn, each with fresh migrated local D1, and runs the conformance scenarios against all three targets. The API probe in `probe/` runs on its own: `wrangler dev --config research/composable-units/t4-linker-dynamic/probe/wrangler.jsonc --local`, then `curl localhost:8787/`. Its output for this run is `probe/result.json`.

Versions: wrangler 4.135.0, workerd 1.20260918.1, miniflare 5.20260918.0-alpha (all from `pnpm-lock.yaml`), Node 24.14.0, Apple M2 Max. Compatibility date 2026-09-25 for host and children, the same as `research/cf-forge` and T1. The whole-app Worker keeps its own date, 2026-09-01.

## Is the Worker Loader available?

| where | finding | source |
| --- | --- | --- |
| local, pinned versions | **Yes, with no compatibility flags.** `worker_loaders` is a known binding in wrangler 4.135.0's config validation, and miniflare's `WORKER_LOADER_PLUGIN` emits a `workerLoader` binding for workerd 1.20260918.1. At compatibility date 2026-09-25 `env.LOADER.get` works, as do `ctx.exports.<Entrypoint>({ props })` stubs in a child's `env`, named-entrypoint RPC into the child, and `globalOutbound: null`. `node:crypto` imports without `nodejs_compat` in host and child. | `probe/result.json` (run 2026-10-23); `grep worker_loader` in the installed wrangler and miniflare dists |
| local semantics | A child with `globalOutbound: null` gets `fetch()` throwing "This worker is not permitted to access the internet via global functions like fetch()". `import { env } from "cloudflare:workers"` in the child returns the child's `env`, not the host's. Two `get()` calls with the same id ran the code callback once. A child whose module graph does not resolve fails with "Failed to start Worker" when first called. | `probe/result.json` |
| local module resolution | Bare specifiers resolve relative to the importing module's *directory*. A module named `@forgegraph/runtime` importing `effect` looks for `@forgegraph/effect`. So the linker puts every module at the root and builds the runtime library to import `../effect`. | `probe/result.json` (`resolution`) |
| deployed | **Not verified.** The docs say Dynamic Workers are "only available on the Workers Paid plan" and do not mention a beta, a waitlist or a compatibility flag for JS. `allowExperimental` needs the loader Worker to carry the `experimental` flag, which "cannot be enabled in production"; this linker does not use it. | developers.cloudflare.com/dynamic-workers/ `pricing/`, `api-reference/`, `getting-started/`, `usage/bindings/`, `usage/egress-control/`, fetched 2026-10-23 |
| caching contract | `get(id, cb)`: "The loader caches isolates by ID", reuse "is not guaranteed", the callback "could run any number of times" and must return "exactly the same content for the same ID". `load()` does not cache. | api-reference, fetched 2026-10-23 |
| cost | 1,000 unique Dynamic Workers a month included, then $0.002 per Dynamic Worker per day; a unique (id, code) pair counts once a day. Billed CPU includes isolate startup. Acme has 56 distinct children (below), so at most 56 per day per deployed manifest, plus a few per swap. | pricing, fetched 2026-10-23 |

## What was built

| piece | where | why there |
| --- | --- | --- |
| linker | `packages/linker-dynamic` (private, `@forgegraph/linker-dynamic`) | A new private package, like `@forgegraph/units`: the linker is a consumer of the manifest, not part of the runtime or the sealer. Linkers A, B and C can share the manifest types without one depending on another. Its only runtime-package change is one additive method (below). |
| resolve | `src/manifest.ts` | Manifest checks that need no module bytes. Routing by trigger. |
| policy and gate | `src/policy.ts`, `src/sql-gate.ts` | Capability policy per entry point, derived from the manifest and the app's SQL schema. A table-level SQL gate. |
| child code | `src/child.ts` | The child's `WorkerCode`: unit modules (sealed bytes, unchanged), the shared libraries, the app bundle and a generated `main.js`. |
| host Worker | `src/host.ts`, `host/acme.ts`, `host/wrangler.jsonc` | Routing, the closure cache, capability stubs (`D1Gate`, `ObjectsGate`, `QueueGate`, `WorkflowGate`, `Egress`), queue/cron/Workflows wiring and `/_linker/*` administration (local only, token-gated). `acme.ts` exports the one Workflows class the platform binds by name. |
| unit store | `src/store.ts` | A content-addressed blob store over a (local) R2 bucket `UNITS`. Every read is checked against its digest. An in-memory store is used by the unit tests. |
| shared libraries | `scripts/build-libs.mjs` | `effect@4.0.3` and `@forgegraph/runtime@0.5.0` as content-addressed blobs: the libraries the unit modules leave as imports (`implementation.libraries`). |
| runtime | `packages/runtime/src/hosts/cloudflare.ts` | No change of its own. Linker B uses the dispatch hand-off FORG-29 added: `WorkerOptions.postCommit` and `createWorker().dispatch()` (see "Dispatch: one mechanism with FORG-29"). |
| schema | `schemas/closure-manifest.schema.json` | Adds an optional `egress` list of origins to an entry point (a proposal; the sealer does not emit it). |

### Request path

1. Match the entry point: an `http-route` by method and path template, preferring static segments. A queue batch is matched by queue name, a Workflows run by `trigger.className`.
2. Derive the policy (below).
3. Child id = `closureHash` + `~` + 16 hex digits of a digest over the blobs the child loads (libraries, app bundle, unit modules), the policy and the vars. On a host cache miss, fetch each blob from the store, verify it against its digest and assemble the `WorkerCode`.
4. Call `env.LOADER.get(id, cb)`. The callback mints the capability stubs for this request and sets `globalOutbound` to `null`, or to the `Egress` gateway when the entry point declares egress. The callback running at all marks the request `x-forge-isolate: cold`.
5. Forward the request to the child's default entrypoint. Then `waitUntil` calls the runtime's `dispatch(tenant, { sweep })` in the dispatch child, which holds the whole app and every queue binding: `sweep` is true after a 2xx mutation, and a tenant this host isolate has not seen yet gets `sweep: false` (the schedule-index record a whole-app Worker makes for every tenant it serves).

Linking (`PUT /_linker/manifest`) resolves the manifest, then checks that every module, library and app blob it names is in the store and that the app bundle's `buildHash` matches. Only then does it move the pointer, so a broken manifest never serves.

### What a child gets

- `DB`: a `D1Gate` stub. The child's generated main turns it back into a `D1Like` (`prepare/bind/first/all/run/batch`), so the runtime's D1 adapter runs unchanged and every statement crosses to the host. The gate checks each statement's tables against the policy: read for any `resource:R#…` import, write for `#write`, `#create` and `#delete`. It also adds the reads the runtime makes inside a write that the manifest does not list: reference guards read the referenced tables and restrict-delete reads the referencing ones (both taken from the schema's foreign keys). Runtime-owned tables (`forge_*`, `_forge_assert`) are open to any closure that touches storage. A statement the scanner cannot classify (`PRAGMA`, `DROP`, …) is refused. Even a closure with no tables gets a gate that refuses everything, because the runtime host builds D1 storage for every request.
- An `ObjectsGate`, `QueueGate` or `WorkflowGate` per `r2`, `queue-producer` or `workflow` binding in the entry point's bindings.
- `CURSOR_SECRET` and `FORGE_AUTH` by value: the manifest's `hostBindings` of type `secret` and `var`.
- Never `LOADER`, `UNITS`, `BLOBS` (unless declared), any other binding, or the admin token.

Unit modules are loaded byte-for-byte as sealed. The generated main checks that each module's default export is the declared `FunctionImpl` (matching `id`) or an `ExternalBinding`.

Three kinds of child are not narrowed, and they are reported as such:

- **The sweep and dispatch child** (`forge:sweep`, the post-commit nudge, every cron) gets the whole app: the runtime's `scheduled()` runs the outbox sweep, every due schedule and the workflow sweep at once.
- **The `uncovered` fallback** gets the whole app too. It runs only with `LINKER_UNCOVERED=runtime`, logs a `FALLBACK` line and sets `x-forge-linker: fallback-whole-app`. It is off by default.
- **The object-bytes route** (`/_forge/objects/<token>`) has no manifest entry point. The host serves it with a synthetic policy: the R2 bindings and no tables.

## Results (local workerd, 2026-10-23)

All timings are client wall time over loopback unless marked host. "Host" is `performance.now()` inside the host from request to child response. It advances during execution only locally, so it is not comparable to a deployed reading. Full data: `results.json`.

| | Linker B host | whole-app Worker |
| --- | --- | --- |
| link the acme manifest (`PUT /_linker/manifest`: resolve, store checks) | 29 ms | n/a |
| first request for a closure (6 list routes) | median 32.5 ms (31.1–46.0); host 30 ms | 23.4 ms for the first request after start, then 3–5 ms |
| of which: fetch + verify + assemble child code (host cache miss) | median 5 ms (3–18, n=11) | n/a |
| warm `GET /v1/customers` (n=30) | median 3.5 ms, p95 5.2 | median 3.8 ms, p95 6.6 |
| warm `GET /v1/orders` / `/v1/sites` (n=30) | 3.1 / 3.0 ms | 2.7 / 3.1 ms |
| `POST …/submit` (2 js units, 1 transition), first | 44 ms (cold) | 9.2 ms |
| `POST …/submit` warm (n=10) | median 13.7 ms, p95 19.9 | median 8.0 ms, p95 11.8 |

Warm read routes cost the same as the whole-app Worker. A warm write costs about 1.7x the whole-app time: each D1 statement and batch is one RPC to the host. A cold child costs about 30 ms locally. Fetching and verifying its blobs and assembling the code is about 5 ms of that. The rest is the loader starting an isolate and evaluating about 850 KB of modules; that remainder was not broken down further.

### Manifest swap

The edit was to `impl/fulfill-order.ts`, which now returns `{ ...order, observedRevision }`. It was re-sealed with the unchanged unit plan.

- Exactly one module blob is new, and exactly one entry point (`fulfill-order`, the queue consumer) gets a new closure hash. The other 63 do not change.
- Uploading the new module took 3.2 ms. Linking the new manifest took 11.1 ms. That is the whole deploy: no script upload.
- After the swap, `GET /v1/customers`, `/v1/sites` and `/v1/orders` were still `warm` (3.3–4.3 ms).
- The consumer's next batch loaded a new child: one cold load for the old closure before the swap and one for the new closure after it, with a 5 ms code build.
- `submit` stayed warm after the swap. The one sample was 40 ms, compared with 13.7 ms before the swap. One sample cannot explain the difference.
- In the tests (`test/host.test.ts`), the same swap of `AuthorizePayment` re-links exactly the 5 entry points whose closure contains it. The submit route goes cold and runs the new limit, while `GET /v1/customers` stays warm.

An edit that esbuild drops, such as a comment or an unused export, leaves the module bytes unchanged. Every hash stays the same, and nothing re-links.

### Sizes

| | bytes | gzip -9 |
| --- | --- | --- |
| `effect@4.0.3` library (namespaces Cause, Context, Data, Effect, Layer) | 92,331 | 32,267 |
| the same with `export * from "effect"` | 785,380 | not measured |
| `@forgegraph/runtime@0.5.0` library (`createWorker`, `defineFunction`) | 205,756 | 63,384 |
| `app.json`, shipped whole to every child | 547,934 | 24,622 |
| one child's code (56 distinct children over 63 entry points) | median 849,248 (849,214–852,026) | median 121,379 |
| generated `main.js` | median 3,227 | |

The unit modules are 183–717 bytes (T2). About 99.6% of every child is the same libraries and app bundle. The loader shares nothing between children, so every cold child re-evaluates them.

## Sandbox

Tested in `packages/linker-dynamic/test/host.test.ts`. A hostile `AuthorizePayment` was sealed into the SubmitOrder closure. It probes its isolate and returns the findings through the error detail.

| probe | result |
| --- | --- |
| `Object.keys(env)` via `import("cloudflare:workers")` | exactly `CURSOR_SECRET, DB, FORGE_AUTH, Q_FULFILL_ORDER` |
| host bindings on `globalThis` (`LOADER`, `UNITS`, `DB`, `BLOBS`, `WF_PROCESS_ORDER`, admin token, …) | none |
| `env.BLOBS` (no `r2` binding in the closure) | `undefined` |
| `fetch()` to any origin, no egress declared | throws ("not permitted to access the internet") |
| `fetch()` with `egress: [<origin>]` declared on the entry point | the declared origin answers 200 through the host's `Egress` gateway. `https://example.com` gets a 403 `x-forge-egress: denied`, recorded as a denial. |
| `SELECT … FROM order_`, `site`, `forge_document` | allowed (declared, reference guard, runtime table) |
| `SELECT … FROM department`, `site_policy` | denied: "has no capability to read department" |
| `DELETE FROM site` | denied: write site |
| `SELECT name FROM sqlite_master` | denied |
| `PRAGMA table_list` | denied: unclassified statement |

## Fail closed

| case | where | outcome | test |
| --- | --- | --- | --- |
| js-module unit whose module hash the manifest does not list | resolve | `MissingUnit`, manifest refused | `resolve.test.ts` |
| closure naming an unknown unit / not closed under dependencies | resolve | `MissingUnit` | `resolve.test.ts` |
| `closureHash` or `manifestHash` not matching content | resolve | `ClosureHashMismatch` / `ManifestHashMismatch` (HTTP 422 at link) | `resolve.test.ts`, `host.test.ts` |
| module hash listed but bytes missing from the store | link | `MissingModule` (503); pointer unchanged; the previous manifest keeps serving | `host.test.ts` |
| bytes present but corrupted | child build | `ModuleDigestMismatch` (503) | `resolve.test.ts` (store) |
| library or app bundle not in the kit | child build | `MissingLibrary` | `resolve.test.ts` |
| unknown entry point (route, changesets, …) | request | 404 `UnknownEntryPoint` | `host.test.ts` |
| websocket upgrade (realtime DO not linked) | request | 501 `UnlinkedEntryPoint` | `host.test.ts` |
| queue with no consumer entry point | queue | every message retried, never acked unseen | not tested (local queues would redeliver to the DLQ) |
| undeclared capability (`Order#write` removed from the submit route) | request | the gate refuses `UPDATE order_`. The runtime answers 503 `StorageUnavailable`, the order stays `Draft`, and the denial is recorded. | `host.test.ts` |

## Conformance differential

`pnpm vitest run test/remote.test.ts` in `conformance/`, through the generated client, against three local targets. Each run used fresh D1. Per-scenario results are in `conformance/*.json`.

| target | scenarios passed | steps | notes |
| --- | --- | --- | --- |
| whole-app Worker (`examples/acme/deploy/cloudflare`) | **15 / 15** | 221 | baseline; needs `CURSOR_SECRET` (the harness passes one) |
| Linker B, strict (default) | **10 / 15** | 221 | 0 capability denials. 38 children. Served http routes, the queue consumer, the workflow class and runtime entry points. |
| Linker B, `LINKER_UNCOVERED=runtime` | **15 / 15** | 221 | 0 denials. 49 requests went through the reported whole-app fallback. |

The 10 scenarios that pass under strict narrowing are customer-crud, site-references, pagination, concurrency, idempotency, integrity, blobs, messaging (through the queue consumer child), workflows (through the Workflows class into the workflow child) and temporal-hierarchy.

The 5 that fail (changesets, csv-import, limits, schedules, views-projections-cache) fail only because a step calls a surface that has no entry point in the T2 manifest and gets `UnknownEntryPoint`. Their other failures are downstream of those steps: records that were never created, and shifted symbolic ids. The refused surfaces:

- views, projections and caches: `/v1/views/pending-orders`, `/v1/customer-order-summaries/*`, `/v1/caches/current-site-policy`, listed in the manifest's `uncovered`
- schedule status and tick: `/v1/schedules/nightly-reconciliation[/tick]`, in `uncovered`
- **changesets** (`/v1/changesets[/{id}/preview|approve|commit]`) and **imports** (`/v1/imports/inspect|stage`), which are **missing from `uncovered` as well**. This is a T2 gap.

Re-run on 2026-10-24 after merging main and moving to FORG-29's dispatch hand-off: same results. Whole-app 15/15, strict 10/15 (the same five scenarios, 0 denials, 38 children), fallback 15/15 (0 denials, 49 fallbacks), 221 steps each. That run used only the conformance section of `measure.ts`, so `results.json` and `conformance/*.json` still hold the 2026-10-23 run.

No scenario was skipped. Realtime (`test/realtime.test.ts`) needs a websocket target and was not run, because the DO is not linked. Cron Triggers were not fired in any run.

## Dispatch: one mechanism with FORG-29

FORG-29 (the packed linker, `research/composable-units/t3-linker-packed/`) and this branch each fixed the same runtime hazard. The dispatcher delivers an outbox row to the subscriptions its Worker knows and then marks the row done, and the post-commit nudge sweeps every pending row of the tenant. A runtime that holds only part of the app must therefore not sweep. This branch first added `createWorker().sweepTenant(env, tenant)` for that. FORG-29, merged first, added three things to the Cloudflare host:

- `WorkerOptions.postCommit(env, tenant)` replaces the in-process nudge;
- `createWorker().dispatch(env, tenant, { sweep })` runs it on a Worker that holds the whole app, and also records the tenant in the schedule index;
- `WorkerOptions.sweeps` limits what a cron invocation runs.

After merging main, `sweepTenant` is gone and Linker B uses FORG-29's API:

| | Linker A (packed, FORG-29) | Linker B (dynamic, FORG-30) |
| --- | --- | --- |
| partial runtime | each sliced script | each narrowed child isolate |
| stops the in-process nudge | `postCommit` forwards over the `FORGE_DISPATCH` service binding | `postCommit` is a no-op, and the child's `fetch` gets no `ctx` |
| who calls `dispatch()` | the `forge:sweep` script, on `POST /_forge/linker/dispatch` | the host, through the dispatch child's `Forge.dispatch(tenant, { sweep })` RPC |
| first-sight tenant tracking | `dispatch(…, { sweep: false })`, once per script isolate | `dispatch(…, { sweep: false })`, once per host isolate |
| cron | `sweeps` narrows each cron script | the whole `scheduled()` in a privileged child (`sweeps` unused) |

`sweepTenant` was a subset of `dispatch(…, { sweep: true })`, so nothing it did is missing, and nothing Linker B needs is outside FORG-29's options. A child cannot call the dispatch child itself (it holds no service binding, only capability stubs). So the host, which already sees the tenant, method and status, makes the call after the child answers, and `postCommit` only has to stop the child from sweeping. One difference: the runtime skips the nudge for signed webhook POSTs, and the host cannot tell those apart. They get an extra `dispatch()`, which is harmless because a sweep is idempotent and the cron runs it anyway. Linker B also gains the first-sight schedule-index record, which a narrowed child did only as an unawaited promise without `ctx`.

In Linker B the hazard is narrower than in a packed slice. Every child loads the whole app bundle, so its model knows every subscription. What it lacks is transports and tables: other closures' queue producers and workflow bindings, and tables outside its policy. A sweep there fails those deliveries rather than marking them done. But each failure costs an attempt and holds the row's 30-second lease (the dispatcher dead-letters after 8), and the gate records a denial. With the hand-off, the request children never claim an outbox row.

Tests:

- `packages/runtime/test/host-dispatch.test.ts` (FORG-29's file plus one case): a slice with `postCommit` leaves another closure's `Order.changes` row pending, and `dispatch()` on the whole app delivers it to `CustomerOrderSummary`. Both linkers rely on this contract.
- `packages/linker-dynamic/test/resolve.test.ts`: the generated child code, narrowed and privileged, sets `postCommit`, calls `fetch` without `ctx`, exposes `dispatch` and has no `sweepTenant`.
- `packages/linker-dynamic/test/host.test.ts`, "dispatch": on local workerd, an order created through the narrowed `POST /v1/orders` child ends with its `Order.changes` row delivered to `CustomerOrderSummary`, claimed once (`attempts = 1`), with no gate denials. This checks the delivery end to end. It cannot show the child holding back on its own: in acme, the projection is the only outbox subscriber for a request child's rows, and it stores into `forge_document`, which every storage-using child may write. With the hand-off removed and the child given `ctx`, the test still passed.

## Findings

1. **Capability narrowing works at closure granularity, not unit granularity.**
   - Unit code can `import("cloudflare:workers")` and call the child's gates directly; the hostile adapter did this. So the boundary is the closure's policy, not the unit's declared dependencies.
   - Per-unit sandboxing would need one child per unit, with cross-unit calls as RPC.
2. **The manifest under-declares what forge-native units touch.**
   - Reference guards and restrict-delete read tables that no import names. The linker derives them from the schema's foreign keys. A consequence: dropping `Site#read` from the submit route changes nothing, because the guard on `Order` writes already reads `site`.
   - Outbox, receipts, audit and documents are runtime tables, so they are not narrowed per capability. For example, `send:` should govern `forge_outbox` writes.
3. **SQL is the wrong layer for the storage capability.** The gate is a scanner over the SQL the runtime generates (tested on its patterns, CTEs and literals), not a parser. A typed storage capability (the `StorageAdapter` methods over RPC, keyed by resource) would narrow by resource and operation instead of by table name. It would also replace one RPC per statement with one per operation.
4. **A refused capability surfaces as `503 StorageUnavailable`.** The D1 adapter treats the gate's error as a storage failure and retries it. The runtime needs a distinct, non-retried `CapabilityDenied`.
5. **`closureHash` is not the whole isolate identity.**
   - It pins unit implementations and library *versions*. It does not pin the linker-built library *bytes*, the app bundle, or the capability policy. Imports are not in `closureHash` at all, and trigger bindings differ between entry points that share a closure.
   - The child id therefore adds a digest of those. Entry points that share a closure share a child when their policies match: 6 groups in acme, such as the process route, the signal route and the workflow class.
6. **The full `app.json` goes to every child** (548 KB, 64% of the child). forge-native units need the model.
   - A `.forge` edit changes `buildHash` and cold-starts every child.
   - An `impl/` edit does not, and leaves the others warm.
   - Slicing the model per closure, or loading it as a shared content-addressed library, is the open question T2 raised.
7. **The library surface is an ABI.**
   - `export * from "effect"` is 785 KB. The surface the runtime and the `forgegraph-function/1` ABI actually use is 92 KB.
   - A unit that imports another Effect name fails to load. That is fail closed, but the ABI must name its library surface.
8. **Secrets pass by value.** `CURSOR_SECRET` (cursor and object-URL signing) is in every child.
   - `FORGE_CORS` is read by the runtime but is not a manifest host binding, so the strict linker does not pass it. CORS headers therefore differ from the whole-app Worker. The conformance scenarios do not cover CORS.
   - Signing could be a host capability instead.
9. **Not every served surface is an entry point.**
   - The planner does not emit changesets, imports or the object-bytes route.
   - Realtime fan-out needs a Durable Object class in the deployed script; Durable Object Facets were not tried.
   - Each Workflows class must be exported by the host by name.
10. **Dispatch had to leave the request child.** The runtime's post-commit nudge sweeps the tenant's whole outbox, not the request's rows, so a narrowed child would try other closures' deliveries without their transports. The host runs it in the dispatch child through FORG-29's `dispatch()` (next section).

## Design questions

1. Should the manifest carry implied capabilities (reference reads, dependents, runtime tables per `send:`/`wait:`/`sleep`) so a linker doesn't re-derive them from the schema?
2. Should storage become a typed capability instead of a gated D1 handle?
3. Should egress be a manifest field (as proposed here, `entryPoints[].egress`) or a capability import (`net:<origin>`)? Who declares it: the unit's interface or the deployment?
4. Should the app model be sliced per closure, or shipped as a content-addressed library keyed by `buildHash` so that `impl/`-only swaps stay warm?
5. How should `closureHash` relate to isolate identity? Should the manifest pin library bytes, or only versions?
6. How should the current-manifest pointer propagate across host isolates? Here it is held per isolate and re-read from R2 when an isolate starts; a deployed host would need KV or a Durable Object.
7. Cron and sweep entry points are privileged because `scheduled()` does everything at once. Should the runtime split sweep, schedules and workflow sweep so that each cron entry point can be narrowed?
8. Under Linker C, should the `uncovered` fallback to the whole-app runtime remain (it is reported), or should every surface become an entry point?

## Missing (not measured)

- Deployed-edge latency, CPU and memory. Nothing was deployed, as the brief required.
- CPU time per child load. Local workerd does not report it.
- Loader eviction. Locally every child stayed warm for the whole run.
- Cron Trigger delivery through the host. `scheduled()` is wired up but untested.
- Realtime, because the DO is not linked.
