# R5: Linker B's loader miss, and a content-addressed unit cache

Research for [FORG-48](https://tasks.gmac.io/gmacko/issue/FORG-48). [R4](../r4-deployed/README.md) measured a linker B
loader miss on a warm host at 458–889 ms deployed, mostly the R2 unit-store fetch (246–614 ms), and a first request on a
fresh host isolate at 1.8–2.3 s. A bare 850 KB child starts in 30 ms. This run finds where the miss time goes, changes how
a closure's code reaches the Worker Loader (`packages/linker-dynamic/src/unit-fetch.ts`), and measures it deployed.

**Labels.** Every number is **measured-deployed** unless it says *local*. The account is Workers Paid `c07a7e70…`
(workers.dev subdomain `gmac`). Every request was served in colo **ORD**. D1 and all three R2 buckets were created in
**ENAM**. The client was a Mac on a residential connection, 33–45 ms from ORD at best (`results/rtt.json`). The run took
place on 2026-10-25 from 18:14 to 19:05 UTC. `x-forge-link-ms` and the breakdown below are host-side wall time. Deployed
timers advance only across I/O, so they count waiting on R2, the Cache API, the loader, the child and D1, not CPU.

## Results

The headline is the paired run `results/miss.3.json`. Its samples alternate between the baseline Worker and the new one,
12 per cell, so both see the same platform conditions. Every sample is a guaranteed loader miss on a **warm host
isolate**: one request evicts the host's caches, gives the next child a new id, then times the miss and a warm repeat in
the same isolate (`/_lab/miss`).

| `GET /v1/customers` (median, p95 in brackets) | miss, host ms | of which build (blobs) | of which child | warm request | **miss − warm** |
| --- | --- | --- | --- | --- | --- |
| **before**: `LINKER_UNIT_CACHE=off` (R2, serial, uncached) | 585–673 (713–1,635) | 409–487 | 159–165 | 40–51 | **540–621** |
| **after**, blobs in the isolate's memory (another closure, or an evicted child) | **106** (150) | 0 | 106 | 32 | **72** |
| after, blobs from the Cache API (memory empty: a new host isolate's view) | 121 (520) | 9 | 110 | 36 | 85 |
| after, blobs from R2 in parallel (nothing cached) | 204 (547) | 92 | 112 | 35 | 169 |

| other routes, after (memory) against before | miss | miss − warm |
| --- | --- | --- |
| `GET /forge/discovery` (no D1) | **71** (100) against 543–555 | **66** against 534–545 |
| `POST /v1/customers` (2–3 D1 statements) | 155 against 661–691 | 79 against 550–602 |

| first request on a **fresh host isolate** (`GET /v1/customers`, `results/fresh.json`, n=7) | host ms (median, range) | resolve (`current()`) | build | child |
| --- | --- | --- | --- | --- |
| before | **2,372** (2,021–2,761) | 1,838 | 407 | 111 |
| after | **531** (457–911) | 410 | 13 (blobs from the Cache API) | 150 |

**Target.** A warm-host loader miss now costs **66–79 ms over a warm request** (medians across routes), under the 100 ms
target. The whole answer is 71 ms on a route without D1 and 106 ms on `GET /v1/customers`, which spends 32 ms warm on its
own D1 statement from ORD to ENAM. What remains is the child's cold start; its floor is explained in the next section.

## 1. Where the miss time went (before)

Instrumentation added to the host: `x-forge-link-breakdown` on every answer (`resolve`, `build`, `child`, and for a build
the layer each blob came from), a per-build report in `GET /_linker/stats` (`closures[].fetches[].reads[]`: digest, size,
layer, ms), and `POST /_linker/evict-host-cache?layers=…`.

- **R2 GETs per closure.** A child of acme needs three large blobs that are the same in every closure: the runtime
  library (211,259 B), Effect (92,331 B) and `app.json` (547,934 B). It also needs 0–4 unit modules of 288 B to 1 KB.
  `GET /v1/customers` has none. That is 3–7 GETs for about 850 KB, and 99% of the bytes are shared by every child.
- **Serial.** The pre-FORG-48 `childFor` awaited each blob in turn. Each GET took 120–174 ms in the paired run (runtime
  158 ms, Effect 120 ms, app.json 174 ms, medians). On its own a GET is 70–100 ms: `results/r2.json` reads the same blobs
  serially in 265 ms, and in parallel in 109 ms (the time of the slowest). An R2 `head` is 69 ms.
- **Hashing, decoding, building the module map.** This is CPU, so deployed timers do not see it: a build from memory reads
  0 ms. *Locally* (Node, `lab/cpu.mjs`), sha256 of all three blobs takes 2.6 ms, decoding them 0.3 ms, and `JSON.parse` of app.json 1.3 ms.
  Hashing is not the cost, so every read stays verified.
- **Rebuilding shared blobs.** The host cached whole `WorkerLoaderCode` by child id, never single blobs. A new closure,
  a re-link that changes one module, or a new library version (R4's salted kits) re-read all 850 KB.
- **Fresh isolate.** `current()` read the pointer, the kit and the manifest (467 KB) from R2 one after another. Then
  `link()` sent one `head` per blob, also serially (7 for acme), and read app.json. The child build then read app.json
  a second time. That came to 1.8 s before the child started.

## 2. What was adopted, and why

`src/unit-fetch.ts` (`UnitFetcher`) owns how a closure's blobs reach the loader. Blobs are content-addressed, so every
copy is immutable. Layers, nearest first:

1. **In-isolate LRU** of verified, decoded blobs (`MemoryUnits`, 32 MiB), shared by every child the host builds. This is
   the win for warm-host misses: the three shared blobs are read once per host isolate. The cached strings are the same
   objects the code cache holds, so it costs little memory. `app.json` is parsed once per entry.
2. **Cache API** (`caches.open("forge-linker-units")`, key `https://units.forge-linker.invalid/sha256/<hex>`,
   `max-age=31536000, immutable`). It outlives host isolates within a colo. Measured match: 5–26 ms per blob, including
   the 548 KB app.json. It works on workers.dev (`results/cache.json`: every put was matched, in the named cache and in
   `caches.default`). Writes go through `ctx.waitUntil` when the caller has a ctx.
3. **R2**, the source of truth, read **in parallel** (at most 6, the per-request connection limit), and deduplicated
   within a request.

**Integrity.** Bytes read from the Cache API or R2 are hashed against their digest before use. A mismatch is a
`ModuleDigestMismatch` naming the layer ("the Cache API copy of blob … hashes to …"). It never falls through to another
layer: the request fails closed. A corrupt Cache API entry is deleted before the error is thrown, so the next request
reads R2. Bytes that fail verification are never kept. The memory layer holds only bytes that passed. Existence stays
the store's: `link()` still checks every blob with an R2 `head` (now in parallel). A cached copy can outlive a deletion
from the store until the next link or eviction. `evict-host-cache` drops all three layers by default, which linker C's
"falls back when a module is missing" test relies on.

**Kill switch and baseline.** `LINKER_UNIT_CACHE=off` restores the pre-FORG-48 path (serial, uncached): that was the
"before" Worker. A list such as `memory,parallel` selects layers. Unknown words are refused.

**Not adopted:**

- **One bundle object per closure** (one GET). The measured miss is dominated by blobs that every closure shares. A
  per-closure bundle would put those 850 KB into every bundle (91 entry points, about 77 MB for acme). It would turn a
  memory hit into a GET, and invalidate every bundle on a library bump. Parallel GETs already cost one round trip (92 ms)
  when nothing is cached.
- **KV for code.** The Cache API is per colo but costs nothing and matched in single-digit milliseconds here. KV's global
  replication helps only the first isolate in a colo, which pays one parallel R2 round trip (about 90 ms) today. Not
  measured.

## 3. The floor: the child's cold start

`results/floor.adhoc.json` loads Dynamic Workers that add one thing at a time (warm host, quiet window, n=10 each, cold
then warm):

| child | cold ms (median, min) | warm |
| --- | --- | --- |
| empty main | 13 (12) | 2 |
| + runtime and Effect (303 KB of minified JS, evaluated) | 49 (41) | 2 |
| + app.json as `{ json }` | 57 (50) | 2 |
| + app.json as `{ text }`, parsed in the child | 53 (45) | 2 |
| + `createWorker(app)` | 56 (48) | 3 |
| + one request through the runtime (401 before storage) | 56 (47) | 2 |

The child's cold start is about 55 ms, and 35 ms of it is evaluating the runtime and Effect. Isolate start is 13 ms.
app.json and `createWorker` add about 7 ms. This is the miss on a route without D1 (66 ms over warm, 71 ms total).
`results/floor.json` repeated it in a slower window (an empty child took 31 ms) and found the same proportions.

On a D1 route a cold child adds about 10–20 ms more (72–79 against 66 ms over warm). Locally, the first request on a new
runtime instance issues three D1 statements for `GET /v1/customers`, where a warm one issues one
(`lab/count-d1.mjs`, *local*). The extra two are the runtime's schedule-index first sight: `SELECT … forge_document
(_forge, schedule, index)` and an `INSERT`. These run once per tenant per child isolate. In a linker B child,
`createWorker().fetch` gets no ctx, so `observeTenant` starts `schedules.track()` as a floating promise. It competes with
the request's own statements on the same D1 and duplicates the host's dispatch-child first sight. This is attributed,
not timed separately. **Next levers, outside FORG-48:** let the child's runtime skip `track()` when the host owns first
sight; and carry fewer library bytes per child.

## 4. Placement for the D1 round trips (`results/d1.*.json`, `results/placement.json`)

| Worker placement | `SELECT 1` per statement (median, min, p95; n=100) | `cf-placement` |
| --- | --- | --- |
| default (ORD) | 16, 11, 24 | (none) |
| Smart Placement, after 25 min and 3,488 requests | 16, 12, 24 | `local-ORD`; API status `INSUFFICIENT_INVOCATIONS`, last analysed at deploy |
| Smart Placement with `hint: "enam"` | about 15–29 (3 probes of 10) | `local-ORD`, still `INSUFFICIENT_INVOCATIONS` |
| `targeted`, `region: "aws:us-east-1"` | **35**, 30, 47 (ORD in the same window: 19, 12, 29) | `remote-IAD` |
| `targeted`, `region: "aws:us-east-2"` | 27, 15, 42 (ORD in the same window: 21, 13, 42) | `local-ORD` |

- **Nothing beat ORD.** An ENAM D1 answers a statement from ORD in 11–16 ms. Moving the Worker to IAD doubled that, so this
  database's primary is nearer ORD than IAD. Ohio resolved to ORD itself.
- **Smart Placement never decided.** Steady traffic from one client location for 25 minutes left it at
  `INSUFFICIENT_INVOCATIONS`. A hint did not change that. It may need traffic from several locations; that was not
  testable from one client.
- **D1 location hints were not re-measured.** ORD is in ENAM, the hint the lab already used, and every other hint is
  farther. For a client population near ORD, ENAM is right.
- **No product default changed.** The evidence says that for this layout the Worker should stay where the request
  arrives. The lever is fewer D1 statements per request (R4: batching, and §3's first-sight read and write), not
  placement.

## 5. Checks

- Linker differential (`TIERED_DIFFERENTIAL=1`, local workerd, `results/differential.local.json`): **15/15** scenarios
  for whole-app, its A/A repeat, A (88 scripts), B, C (89 scripts) and C's fallback, with no unexplained differences. B's
  realtime check fails as on main (`r3-linker-tiered/results/conformance.json`), because B does not link the realtime
  Durable Object.
- `@forgegraph/linker-dynamic` 46/46, including `test/unit-fetch.test.ts` (layers, the off path, the parallel bound,
  a corrupt Cache API entry, corrupt or missing store bytes, the LRU) and the host test "FORG-48: a loader miss reads a
  closure's blobs from memory, then the Cache API, verified" on local workerd. `@forgegraph/linker-tiered` 18 passed and
  7 skipped (the opt-in differential, run separately). `@forgegraph/units` 40/40.
- `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm install --frozen-lockfile` (no lockfile change), and
  `./scripts/refresh-fixtures.sh`, which left the tree clean.

## Reproduce

```sh
cargo build --locked -p forgegraph-cli && pnpm install --frozen-lockfile
pnpm --filter @forgegraph/linker-dynamic build && pnpm --filter @acme/commerce-deploy units:build
# resources (below), D1 migrations for acme; forge target add miss-base|miss-b|miss-smart --stage staging
#   (appDir research/composable-units/r5-loader-miss, buildCommand `node build.mjs <t>`, deployCommand
#   `../../../packages/linker-dynamic/node_modules/.bin/wrangler deploy --config dist/<t>/wrangler.jsonc`,
#   syncSecretsInclude MISS_LAB_TOKEN MISS_LINKER_ADMIN_TOKEN MISS_CURSOR_SECRET); forge secret set … --stage staging
# forge deploy create staging --ref <branch> --break-glass --target <t>
FORG48_SECRETS=secrets.json node research/composable-units/r5-loader-miss/measure.ts rtt seed cache r2 miss floor fresh d1
RUN=3 TARGETS=miss-b,miss-base N=12 node research/composable-units/r5-loader-miss/measure.ts miss   # the paired run
```

| file | |
| --- | --- |
| `build.mjs` | builds one lab Worker into `dist/<target>/`. `miss-base` sets `LINKER_UNIT_CACHE=off`. `miss-smart` takes `LAB_PLACEMENT` (JSON) |
| `lab/linker-b.js` | linker B's host (`packages/linker-dynamic/src/host.ts`) behind R4's lab gate, with secrets renamed (`MISS_*`) and the probes `/_lab/miss`, `/_lab/floor`, `/_lab/r2`, `/_lab/cache`, `/_lab/d1` |
| `lab/names.mjs` | every resource name |
| `lab/count-d1.mjs`, `lab/cpu.mjs` | *local*: D1 statements on a new runtime instance against a warm one; CPU of hashing, decoding and parsing |
| `measure.ts` | the sections, writing `results/<section>[.<run>].json`; `MEASURED=local` labels a local run |
| `results/summary.json` | the headline numbers above, read from the section files |

## ForgeGraph and Cloudflare notes

1. **The first deploy of a new Worker failed twice, and a retry succeeded both times.** `miss-b`: wrangler uploaded the
   script, then `/workers/scripts/<name>/subdomain` answered 10007 "This Worker does not exist" (`f2bc28fe`). `miss-base`:
   the post-deploy health probe got 404 "error code: 1042" from the new workers.dev hostname (`8a2b071d`). ForgeGraph
   could retry once on both.
2. **Targets with history still cannot be removed.** `forge target remove miss-b` answers 409 ("still referenced by 3
   deployments"), as in R4. The three targets are retired instead (below).
3. **Cache API entries cannot be purged after their Worker is deleted.** The lab wrote about 850 KB of public code (acme's
   app.json, the runtime and Effect libraries) under a reserved hostname in ORD's workers.dev cache. No zone purge
   reaches it. The entries are immutable, public and verified on read; the cache evicts them in time. A future lab
   should call `evict-host-cache` (cache layer) before deleting its Workers.
4. Smart Placement reported `INSUFFICIENT_INVOCATIONS` after 25 minutes of steady traffic from one location (§4).

## Created and deleted

All times are UTC on 2026-10-25. FORG-47's agent was not on the stage when this lab started. Its `forge-lab-c-*` Workers
appeared on the account during the run; they were not touched.

| when | what |
| --- | --- |
| 18:14:45 – 18:15:04 | wrangler created D1 `forge-lab-miss-acme` (`c84a478c…`, ENAM) and R2 `forge-lab-miss-units-base`, `forge-lab-miss-units-b` and `forge-lab-miss-units-smart` (all ENAM) |
| 18:15:25 | acme's D1 migrations 0001–0006 applied (remote) |
| 18:15:53 – 18:15:55 | `forge secret set` MISS_LAB_TOKEN, MISS_LINKER_ADMIN_TOKEN, MISS_CURSOR_SECRET `--stage staging` (random values, kept in a local file outside the repository, deleted afterwards) |
| 18:16:05 – 18:16:07 | `forge target add` miss-base (`c43fd667`), miss-b (`ef9a2159`), miss-smart (`ac2519d2`) on forge-console's retired `staging` stage (sortOrder 90), pinned to hetzner-master. Production's targets were snapshotted first |
| 18:16 – 18:21 | `forge deploy create staging --ref FORG-48-loader-miss --break-glass --target <t>`: miss-b `f2bc28fe` failed (note 1), `7bf160c2` active (882a9ce); miss-base `8a2b071d` failed (note 1), `bfa5207a` active (882a9ce); miss-smart `7e858b2a` active (882a9ce, Smart Placement) |
| 18:28:40 | miss-b `fa7430d7` (ac8a018, adds `/_lab/floor`) |
| 18:55 – 19:00 | miss-smart's buildCommand set to `LAB_PLACEMENT=…`, deployed as `5b0cd4e1` (smart, hint enam), `cbbb54a6` (targeted aws:us-east-1) and `9d3b5649` (targeted aws:us-east-2), all at ea34e8e |
| 18:21:44 – 19:00:53 | measurements |
| 19:01:44 – 19:01:49 | `wrangler delete` forge-lab-miss-b, forge-lab-miss-b-base, forge-lab-miss-b-smart |
| 19:02:12 | `wrangler d1 delete forge-lab-miss-acme` |
| 19:03:14 – 19:04:16 | 9 objects deleted from each bucket, then `wrangler r2 bucket delete` for all three (a first attempt at 19:02 deleted nothing: a shell quoting slip) |
| 19:04:34 | `forge secret rm` for the 3 MISS_* secrets; `forge secret list --stage staging` then showed none |
| 19:04:37 – 19:04:41 | the 3 targets retired: `buildCommand` echoes "FORG-48 lab retired" and exits 1, `deployCommand` is `exit 1`, `syncSecrets` is false, and the include list and health URL are cleared |
| 19:04:58 | `forge target remove miss-b`: 409 (note 2) |
| 19:05:03 | Cloudflare API: no `forge-lab-miss*` Worker scripts (275 on the account, `forge-console` present), no `*miss*` D1 database or R2 bucket |
| 19:05:04 | `forge target list --stage production --json` byte-identical to the snapshot from before the run (sha1 `9843aa23…`); `forge.gmac.io/healthz` 200 |

## For FORG-47 (the manifest pointer and stats in a Durable Object)

- **Changed in `host.ts`:**
  - `link(store, kit, manifest, env)` gained `env`, so it can read `LINKER_UNIT_CACHE`.
  - Its existence checks go through `missingBlobs()` (in parallel). Its app-bundle read goes through `UnitFetcher.json()`.
  - `childFor` and `dispatchChild` take `HostCtx` (`exports` plus an optional `waitUntil`).
  - `ClosureStats` has `fetches`.
  - `GET /_linker/stats` adds `unitFetch`.
  - `evict-host-cache` takes `?layers=` and bumps a `generation` that is part of every child id (only when non-zero, so
    ids are unchanged otherwise).
  - The fetch handler times `current()` as `resolve` in `x-forge-link-breakdown`.
- **`current()` is untouched.** It is 410 ms of a fresh isolate's 531 ms first request: three serial R2 reads (pointer,
  kit, the 467 KB manifest) plus parallel heads. When the pointer moves into the Durable Object, read the manifest blob
  through `new UnitFetcher(store, { config: unitFetchConfig(env.LINKER_UNIT_CACHE), cache: await openUnitCache() }).json(digest, "manifest")`.
  The manifest is content-addressed too, so it gets the Cache API and the memory layer for free, verified. Fetch the kit
  alongside it, not after it.
- If stats move to the Durable Object, `fetches` (per-build `FetchReport`: layer counts, store bytes, per-blob ms) is the
  field to carry.
