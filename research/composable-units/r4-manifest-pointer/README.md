# R4: a shared manifest pointer and shared tier stats for linkers B and C

Research for [FORG-47](https://tasks.gmac.io/gmacko/issue/FORG-47), round 4 of composable units
([plan](../../../docs/plans/2026-10-25-composable-units-round-4.html)). FORG-38 deployed linkers B and C
and found three problems ([R4 deployed](../r4-deployed/README.md)):

- a manifest swap reached only the host isolate that took the PUT, so the other isolates went on serving
  the old closure (409s);
- after linker C's good manifest was restored, a later submit still fell back with `LoadFailed`;
- the tiered router's stats were per isolate, and `since` read 1970.

This change moves the current-manifest pointer, and C's stats, into Durable Objects. Then it checks the
result locally, with several workerd isolates, and deployed, on the r4 lab. **Numbers are labelled
local or measured-deployed.**

## Design

### Durable Object layout

| object | class (exported by) | binding | name | holds |
| --- | --- | --- | --- | --- |
| manifest pointer | `ManifestPointer` (B's host script; C's tier host script) | `LINKER_POINTER` | `pointer:<scope>` | `version`, `manifestHash`, `manifestBlob`, `kitBlob`, `closures` (entry point → closureHash), `dynamic` (C: the tier's dynamic entry points → closureHash), `updatedAt`, the last 10 pointers |
| tier stats | `TierStats` (C's tier host script; the router binds it by `script_name`) | `FORGE_TIER_STATS` | `tier` | `since`, `dynamic`, `packed`, `fallback`, `errors`, `byReason`, `byEntryPoint`, the last 50 fallbacks, workflow advances and fallbacks, reporting isolates |

Code: `packages/linker-dynamic/src/pointer.ts` (pure: CAS, cache, errors), `src/pointer-object.ts` (the DO),
and `src/host.ts` (`resolveCurrent`, the manifest PUT, `GET /_linker/pointer`). C's side is
`packages/linker-tiered/src/stats.ts` (pure: aggregation and each isolate's reporter), plus `src/host.ts`
(`TierStats`, and the dynamic set on swap) and `src/link.ts` (router, configs). Both scripts declare the
classes in a `new_sqlite_classes` migration, tag `forge-linker-pointer-v1`.

The pointer names blobs and does not hold them. Module bytes, the manifest and the kit stay in the
content-addressed unit store, and their fetching and caching are FORG-48's. `PUT /_linker/kit` still
stages a kit; the next manifest swap pins it in the pointer as `kitBlob`, so the pointer alone says what
serves. The old R2 key `pointer/current` is no longer read.

### Compare-and-swap

`PUT /_linker/manifest` takes `If-Match: "<version>"` (or `x-linker-pointer-version`), the version it
replaces. Without one, the host uses the version it read just before swapping, so an unconditional PUT
cannot overwrite a swap it never saw. Old harnesses stay compatible. The DO method does one storage read
and one write, so its input gate makes the swap atomic. A stale writer gets **409 `StalePointer`** with
`expected`, `current` and the current `manifestHash`, and the pointer does not move. A good swap answers
`version`, `previousVersion`, `previous` (the manifest hash it replaced, shared, not per isolate),
`scope`, `kitBlob` and an `ETag`. `GET /_linker/pointer` reads the DO directly and adds this isolate's
cached view.

### Revalidation bound

Each host isolate caches the pointer for **`LINKER_POINTER_TTL_MS`, default 1000 ms** (0 means a DO
read on every request). When a request finds its isolate's copy older than that, it reads the DO first,
and concurrent requests in the isolate share the read. **A swap whose PUT has answered at time T is
served by every request that starts after T + TTL, on every isolate.** The isolate that made the swap
serves it at once. Inside the window a request may still get the previous manifest, which is complete and
verified. Every answer says which pointer served it: `x-forge-pointer: cached|revalidated|changed; v=<n>`,
and `x-forge-pointer-ms` gives the DO read time. On Workers the clock reads the request's arrival time at
its start, so the bound is measured in real time there too.

When an isolate meets a new version it re-links: it reads the manifest and kit blobs (digest-verified)
and the app bundle, and resolves the manifest. It skips the writer's existence checks, because blobs are
immutable and each blob a child loads is verified when it loads. It keeps the linked state of its last
4 pointers, so a swap-back costs no re-link.

### Failure modes

| case | linker B | linker C |
| --- | --- | --- |
| DO unreachable when a revalidation is due | 503 `LinkerRefused`, `reason: "PointerUnavailable"`, with `x-forge-linker-refused: LinkerRefused` and `x-forge-linker-refused-reason: PointerUnavailable`. Never served from an older copy. | The router falls back to the packed script, logs `FALLBACK … (LinkerRefused/PointerUnavailable)` and counts it under that reason. Workflow steps fall back per step and are counted. |
| no `LINKER_POINTER` binding | `LinkerRefused`, reason `NoPointerBinding` | the same fallback |
| DO unreachable during a swap | the swap is refused (503 `LinkerRefused`), never applied locally | the same |
| stale CAS | 409 `StalePointer`, pointer unchanged | the same |
| within the bound, DO unreachable | served from the cached copy: by the bound's definition it is current to within TTL | the same |
| queue batch while refused | retried (fail closed, as for any refusal) | not linked in C |
| stats DO unreachable | n/a | Requests are unaffected. A flush failure keeps the delta for the next flush and logs `stats flush failed`. A stats read answers 503 `StatsUnavailable` with the isolate's own counts. |

### Scopes

A host serves `LINKER_SCOPE` (default `default`), and the admin API takes `?scope=<name>`
(`[a-z0-9][a-z0-9:._-]{0,63}`), one DO per scope. LOOM-19 can keep one pointer per Loom Session
(`session:<id>`) and map a preview host to it without a new layout. Sessions are not built here.

### Stats, without a DO trip per request

Every router and tier-host isolate counts locally and reports deltas from `ctx.waitUntil`, after its
answer. Ordinary requests flush at most once per `TIER_STATS_FLUSH_MS` (default 1000) per isolate.
Fallbacks and errors flush at once, still in `waitUntil`. **No request waits on the stats DO.** The
trade-off is that the shared counts lag each isolate by up to the flush interval; a stats read flushes its
own isolate first. `since` comes from the DO's clock when the counts were created or reset. An old link
with no binding answers its own isolate's counts and says `scope: "isolate"`.

## Tests (local)

| | where | result |
| --- | --- | --- |
| CAS, history, scopes, If-Match parsing; cache bound, TTL 0, shared reads, DO down within and after the bound, no binding, swap while down; linked-state cache | `packages/linker-dynamic/test/pointer.test.ts` (Node) | 14 pass |
| B's host under `wrangler dev`: the pointer in the DO, versioned CAS, stale writer refused, swap-back, `x-forge-pointer`, an unlinked scope at version 0 (with the existing 10) | `packages/linker-dynamic/test/host.test.ts` | 11 pass |
| stats aggregation over isolates, batching (one flush per isolate per window), urgent fallback flush, failed flush kept and retried, no binding, reset | `packages/linker-tiered/test/stats.test.ts` (Node) | 5 pass |
| **several isolates**: B as 4 workerd isolates over one pointer; C as 3 router → tier-host pairs | `packages/linker-tiered/test/pointer.test.ts` | 9 pass |
| package suites | linker-dynamic, linker-tiered, linker-packed, units | 51, 32, 36, 40 pass (the skips are the opt-in differentials) |
| linker differential (whole-app, whole-app A/A, A, B, C, C without a manifest) | `results/conformance.json` | 15/15 on every target, 0 unexplained differences |

The workerd test (`results/local.json`, TTL 500 ms, polled every ~25 ms):

- **B, swap and swap-back.** 3 isolates, swapped from isolate 0 and back from isolate 1. The new version
  first appeared at 1, 171 and 250 ms, then at 466, 0 and 399 ms. Every request that started after the
  bound saw the new version; the test fails on any that did not. A 1500.00 order was authorized on every
  isolate after the swap, and declined on every isolate after the swap-back.
- **Stale CAS.** `If-Match: "1"` against version 3 gave 409 `StalePointer` (expected 1, current 3), and the
  pointer did not move.
- **DO down.** An isolate bound to a pointer DO that always throws answered 503 `LinkerRefused` /
  `PointerUnavailable`, and its swap was refused too. The healthy isolates were unaffected.
- **C, FORG-38's sequence.** Swap, then break (AuthorizePayment throws while it is evaluated), then
  restore, each through a different tier host. After the break, both healthy pairs fell back with
  `LoadFailed`. After the restore, 3 rounds of submits through both were all `dynamic`, with no fallback.
- **C, pointer down.** That pair's dynamic requests fell back as `LinkerRefused/PointerUnavailable`, and
  its packed reads were unaffected.
- **C stats.** Read through router 0, the counts were shared (`scope: "shared"`), and all 3 router
  isolates had reported. `byReason` was `{ LoadFailed: 2, "LinkerRefused/PointerUnavailable": 2 }`,
  router 1 gave the same answer, and `since` was a real 2026 time.
- The local pointer read time is below workerd's timer resolution: it reads 0 ms (max 2).

**One dispatch owner.** In the differential's tiered target, B's host made no dispatch child
(`dispatchChildren: 0`), so linker A's sweep script is the only dispatcher, as in R3. The fallback run is
the same. `dynamic` (B alone) keeps its own dispatch child, by design, and its realtime check fails as in
R3, because B links no realtime object. Router counts: tiered `dynamic: 34, fallback: 0, errors: 0`;
tiered-fallback `fallback: 34`, all `NoManifest`.

## Deployed re-check (measured-deployed)

The r4 lab ([build.mjs](../r4-deployed/build.mjs), with the linker DOs added) was deployed through
ForgeGraph app `forge-console`, on its retired `staging` stage (sortOrder 90), from commit `1ae7093`, with
`forge deploy create staging --ref FORG-47-manifest-pointer --break-glass --target <t>`. Only the 7
targets needed were re-enabled (`linker-b`, `c-router`, `c-dynamic`, `c-get-customers`, `c-post-orders`,
`c-submit`, `c-sweep`). Workers Paid account `c07a7e70…`, every request served by colo **ORD**, D1 in
**ENAM**, defaults TTL 1000 ms and flush 1000 ms. Run: 2026-10-25, 18:51:51–18:56:44 UTC.
`measure.ts` sections `seed read swap-b cas swap-c stats-c`; results in `results/`.

### Pointer read cost (`results/read.json`)

288 requests to B in bursts of 12, alternating 100 ms and 1,300 ms gaps; 7 host isolates answered.

| | n | DO read (`x-forge-pointer-ms`), median / p95 / max | host link ms (`x-forge-link-ms`), median / p95 |
| --- | --- | --- | --- |
| cache hit (`cached`) | 167 | **0** (no DO call) | 24 / 154 |
| revalidation, same version (`revalidated`) | 113 | **12 / 18 / 25 ms** | 37 / 57 |
| first sight of a version on an isolate (`changed`) | 8 | 13 / 40 / 40 ms | 1,019 / 1,128 (re-link from R2 and a cold child: FORG-48's cost) |

A busy isolate pays the DO read at most once per second, and requests it serves within the bound pay
nothing. The read is 7–25 ms here, ORD to the DO's location. At the default TTL, that is under 2% of a
busy isolate's request time.

### Swap visibility on B (`results/swap-b.json`)

Three cycles of swap (limit 1000 → 2000) and swap-back, each a CAS naming the current version. Probes ran in
bursts of 8 every ~40 ms **throughout the PUT**, so isolates held fresh copies when the DO committed. The
times below are relative to the PUT's answer on the client, which comes after the commit.

| | isolates | latest old answer sent | every isolate on the new version by | answers sent ≥ 1000 ms after the answer still on the old version |
| --- | --- | --- | --- | --- |
| swap v8 / back v9 | 6 / 7 | before the answer / before | 597 / 58 ms | 0 / 0 |
| swap v10 / back v11 | 7 / 7 | 76 / 280 ms | 728 / 411 ms | 0 / 0 |
| swap v12 / back v13 | 8 / 7 | before / 784 ms | 478 / 935 ms | 0 / 0 |

Across 984 answers, **no answer sent after the 1000 ms bound served an old version**, and the slowest
isolate switched within 935 ms. All 36 submits after the 6 swaps were served by the swap's version: 18
`Submitted` at 1501.00 after a swap, and 18 declined with 409 after a swap-back. A PUT took 2.2–3.6 s,
which is the writer's link checks (one R2 head per blob), not the DO. An earlier run that probed only
after the PUT (`results/swap-b.idle.json`) saw every isolate switch within 2 ms: their copies had expired
during the PUT. That is why the run above probes throughout.

### Stale CAS (`results/cas.json`)

`If-Match: "6"` against version 7 gave 409 `StalePointer`, and the pointer stayed at version 7, unchanged.

### Linker C: FORG-38's swap, break and restore (`results/swap-c.json`, `results/stats-c.json`)

Each step was a CAS on the tier host, with dynamic `POST /v1/orders` probes through the router during
and after it, then 8 submits at 1501.00. 4 tier-host isolates answered.

| step | latest old answer | all on the new version by | submits after |
| --- | --- | --- | --- |
| swap | before the answer | 885 ms | 8 `dynamic`, 200 `Submitted` |
| break | before the answer | before the answer | 8 `packed-fallback`, `LoadFailed`, 409 (packed limit) |
| restore | 656 ms | 907 ms | **8 `dynamic`, 0 fallbacks** |

**This is the FORG-38 case: after the restore, nothing fell back.**

**Stats.** Ten reads of `GET /_forge/tiered/stats` gave the same answer: `scope: "shared"`, `dynamic: 316`,
`fallback: 8`, `byReason: { LoadFailed: 8 }`, aggregated from **7 router isolates**, with
`since: 2026-10-25T18:55:59.503Z`. FORG-38 got 1970 here. The reads came from one router isolate, but the
counts came from all seven. `packed: 0`, because this run sent no packed request through the router.

### Not measured deployed

- The pointer DO unreachable. There is no clean way to make a deployed DO fail; this is covered locally,
  in workerd (above), and in Node.
- Placement. The DO's location was not pinned. Every request came from ORD.

## Created and deleted

All times are UTC, 2026-10-25. Resources were created and deleted with wrangler; Workers were deployed
by ForgeGraph and deleted with `wrangler delete` (ForgeGraph cannot, FORG-38's gap 5). Other agents'
`staging` targets (`miss-*` for FORG-48, `build-service` for FORG-50) and their `MISS_*` and
`BUILD_SERVICE_TOKEN` secrets were left alone. None of them syncs the secret names used here.

| when | what |
| --- | --- |
| 18:08:13 | snapshot of the staging targets (retired configs) and of production's targets |
| 18:22:12 – 18:22:23 | D1 `forge-lab-acme` (`db8f820a…`, ENAM), R2 `forge-lab-units-b` and `forge-lab-units-c`, queue `forge-lab-acme-fulfill-order` |
| 18:22:36 | acme's D1 migrations 0001–0006 applied |
| 18:22:49 | `forge secret set` LAB_TOKEN, LINKER_ADMIN_TOKEN, TIER_STATS_TOKEN, CURSOR_SECRET `--stage staging` (random values, kept only outside the repository) |
| 18:23:40 | `forge target update`: 7 targets re-enabled (FORG-38's config, cargo cache `/mnt/master-apps/cache/forg47-lab-cargo`); production targets compared, unchanged |
| 18:24 – 18:51:38 | deployments `ba5cd38e` c-sweep, `0f8163bc` c-get-customers, `f31b2860` c-post-orders, `21685730` c-submit, `fdd21318` c-dynamic, `a4e04f71` c-router, `18ca226e` linker-b (all commit `1ae7093`, all active) |
| 18:51:51 – 18:56:44 | measurements |
| 18:56:47 – 18:56:59 | `wrangler delete` of the 7 `forge-lab-*` Workers (with them, their Durable Object namespaces) |
| 18:57:09 – 18:57:14 | a first R2 cleanup failed: wrangler's OAuth token may not list objects through the REST API, so the buckets were not empty |
| 18:57:54 – 18:58:05 | a temporary Worker `forge-lab-forg47-r2-cleaner`, bound to both buckets, deleted 12 and 14 objects (0 remaining); it was then deleted |
| 18:58:15 – 18:58:22 | `wrangler r2 bucket delete` (both), `wrangler d1 delete forge-lab-acme`, `wrangler queues delete forge-lab-acme-fulfill-order` |
| 18:58:25 | `forge secret rm` of the 4 staging secrets |
| 18:58:43 | `forge target update`: the 7 targets retired again, byte-identical to the 18:08 snapshot (checked); production targets compared, unchanged |
| 18:58:46 | removed the 1.5 GB cargo cache on hetzner-master |
| 18:58:53 | check: each of the 8 Workers answers 404 and "does not exist" (10007); no `forge-lab-acme` D1, no `forge-lab-units-*` bucket, no lab queue; `forge.gmac.io/healthz` 200 |

forge-console production was not deployed and its targets were not changed. The `staging` stage remains,
with 9 retired targets, because ForgeGraph cannot remove a stage that has deployment history (FORGE-219).

## Reproduce

```sh
cargo build --locked -p forgegraph-cli && pnpm install --frozen-lockfile
pnpm -r run build && pnpm --filter @acme/commerce-deploy units:build
# local
pnpm --filter @forgegraph/linker-dynamic test
POINTER_RESULTS=$PWD/research/composable-units/r4-manifest-pointer/results pnpm --filter @forgegraph/linker-tiered exec vitest run test/pointer.test.ts
# differential: r3's run.sh links, then
TIERED_DIFFERENTIAL=1 LINK_RESULTS=$PWD/research/composable-units/r4-manifest-pointer/results pnpm --filter @forgegraph/linker-tiered exec vitest run test/differential.test.ts
# deployed: r4-deployed's resources and targets (README there), then
FORG38_SECRETS=secrets.json node research/composable-units/r4-manifest-pointer/measure.ts seed read swap-b cas swap-c stats-c
```
