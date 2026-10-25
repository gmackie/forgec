# R4: Linkers B and C on a deployed Workers Paid account

Research for [FORG-38](https://tasks.gmac.io/gmacko/issue/FORG-38). Until now every reading for linker B
([T4](../t4-linker-dynamic/README.md)), linker C ([R3](../r3-linker-tiered/README.md)), JSPI
([R2](../r2-wasm-async/README.md), [R3 pool](../r3-wasm-pool/README.md)) and the shared-runtime
invocation budget ([R3 runtime cost](../r3-runtime-cost/README.md)) came from local workerd. This run
deployed them to Cloudflare, measured them, and tore them down again. Design:
[composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html).

**Every number below is measured-deployed** unless it is in a "local" column, which quotes the earlier
local results. The account is the Workers Paid account `c07a7e70…` (workers.dev subdomain `gmac`). Every
request was served by colo **ORD**. The client was a Mac on a residential connection, and its floor to
ORD was 29–30 ms (`results/rtt.json`, minimum of `GET /_lab/whoami`; the median was 61–135 ms, because
the connection is noisy). D1 databases were created in **ENAM**. The run took place on 2026-10-25 from
15:37 to 17:31 UTC.

## Reproduce

```sh
cargo build --locked -p forgegraph-cli && pnpm install --frozen-lockfile
pnpm --filter "@forgegraph/linker-tiered^..." run build && pnpm --filter @acme/commerce-deploy units:build
# 1. resources (README "Created and deleted"), then D1 migrations for acme
# 2. add the staging stage (git history: FORG-38's first commit has it in .forgegraph.yaml), forge apply,
#    forge secret set LAB_TOKEN LINKER_ADMIN_TOKEN TIER_STATS_TOKEN CURSOR_SECRET --stage staging
# 3. forge deploy create staging --ref <branch> --break-glass --target <t>   (order: lab/names.mjs)
FORG38_SECRETS=secrets.json node research/composable-units/r4-deployed/measure.ts \
  rtt b-seed c-nomanifest c-seed b c rpc loader jspi evict-many eviction-b eviction-loader eviction-hold
CLOUDFLARE_API_TOKEN=… ACCOUNT=… FROM=… TO=… D1_IDS=… node research/composable-units/r4-deployed/analytics.ts
```

| file | |
| --- | --- |
| `build.mjs` | builds one lab Worker into `dist/<target>/`, run by ForgeGraph's agent as the target's `buildCommand` |
| `lab/linker-b.js`, `lab/gate.js` | linker B's host (`packages/linker-dynamic/src/host.ts`, unchanged) behind a lab gate: a token on every request, and the isolate identity on every answer |
| `lab/probe.js`, `lab/rpc-callee.js` | the invocation-limit probe, the Worker Loader probe and pricing's WASM components |
| `lab/names.mjs`, `tiered-policy.lab.json` | every resource name; linker C's lab policy |
| `measure.ts`, `analytics.ts` | the measurements (`results/<section>.json`) and the usage and cost readout (`results/analytics.json`) |

## What was deployed, and how

**ForgeGraph app `forge-console`, a temporary stage `staging` with sortOrder 90.** ForgeGraph auto-deploys
only the lowest sortOrder, and production is 20, so the lab stage could never be the auto-deploy target.
Stage names are an enum (`development`, `staging`, `beta`, `production`), so `lab` was refused. `development`
scopes secrets per developer, which leaves `staging`. Before `forge apply`, `forge config-diff` showed
exactly one change (`+ stage.staging (new)`). Production's stage and its server-side `worker` target were
compared before and after every ForgeGraph write, and they were unchanged each time. `forge.gmac.io/healthz`
answered 200 after teardown.

Nine `cloudflare-workers` targets were pinned to hetzner-master (`e147e01c…`), with `appDir`
`research/composable-units/r4-deployed`. The `buildCommand` was `PATH=$HOME/.cargo/bin:$PATH CARGO_TARGET_DIR=/mnt/master-apps/cache/forg38-lab-cargo node build.mjs <t>`.
The `deployCommand` was `../../../packages/linker-dynamic/node_modules/.bin/wrangler deploy --config dist/<t>/wrangler.jsonc`,
to which the agent adds `--name <workerName>`. Secrets reached the Workers through `syncSecrets` with a
per-target `syncSecretsInclude`. The agent clones the commit and runs `pnpm install --frozen-lockfile` at
the root (not `npm ci`: it chooses by lockfile). The repository's own tooling then does the rest.

**forgec.** The C targets and the probe need sealed units, so the build compiles forgec on the agent.
`CARGO_TARGET_DIR` points outside the throwaway clone, so the compile is paid once: about 20 s
incremental after that. This beat committing prebuilt artifacts, because a sealed acme is about 1 MB with
`app.json`, and C's packed scripts are 250–330 KB each.

| Worker | what | deployment (commit) |
| --- | --- | --- |
| `forge-lab-linker-b` | linker B's host for acme: LOADER, R2 `forge-lab-units-b`, D1 `forge-lab-acme`, queue producer | `46392bfb` (`6f9708e`) |
| `forge-lab-c-router` | linker C's tiered router for acme under the lab policy (dynamic: `POST /v1/orders`, `POST /v1/orders/{order}/submit`) | `2e104fe5` (`6f9708e`) |
| `forge-lab-c-dynamic` | C's tier host (B's host + tier guard), R2 `forge-lab-units-c` | `00e74391` (`6f9708e`) |
| `forge-lab-c-get-customers`, `-c-post-orders`, `-c-submit` | linker A's packed scripts: one packed route and the two dynamic routes' fallbacks, byte-identical to the link | `edec0428`, `4b02e55d`, `5ad7449a` (`6f9708e`) |
| `forge-lab-c-sweep` | A's dispatch owner (`forge:sweep`'s script); `FORGE_DISPATCH` of every other C script | `c199e428` (`6f9708e`) |
| `forge-lab-probe` | invocation-limit caller, Worker Loader probe, pricing's PriceCart and QuoteOrder WASM components (static and in a Dynamic Worker); D1 `forge-lab-pricing` | `36b389a5` (`6f9708e`), `c750939b` (`9685d6b`), `3014a42f` (`063fd8a`) |
| `forge-lab-rpc-callee` | the probe's RPC callee (FORG-42's runtime Worker stand-in) | `b9cc852d` (`a228fdc`) |

Failed deployments were `6c3082d2` and `7bb54822`, where the build lacked the runtime's `dist/` (fixed in
`07df02d` and `6f9708e`), and `5695c9fa`, refused by the source-order guard (see the ForgeGraph gaps below).

**Linker C is a cut, not the whole link.** acme's full tiered link is 87 packed scripts, a router and a tier
host. That would mean 89 ForgeGraph targets, and with 273 scripts already on the account it would come
close to the 500-script limit. `build.mjs` links the whole of C (linkTiered, unchanged) and deploys 6
scripts from it. Every script is C's output byte for byte (`//lab.scriptHash` in each config), apart from
the lab gate around the router and the tier host. Configs are rewritten to lab names and resources. They
have no Durable Object (`REALTIME`), no Workflows, no cron and no queue consumer, because none of the
scripts those would reach is deployed. The router keeps service bindings to the deployed scripts only, so
its other routes answer 500. C's customers and sites were created through B's host, which shares C's D1.
The tier host's manifest, sealed on hetzner-master, had the same `manifestHash` as the one sealed on the Mac
(`60d3da69…`, `results/c-seed.json`), so sealing is reproducible across machines.

## 1. The Worker Loader on this account

| question | answer | evidence |
| --- | --- | --- |
| available? | **Yes.** `worker_loaders` deployed with no flag at compatibility date 2026-09-25, on Workers Paid. `env.LOADER` is `[object WorkerLoader]` with `get` and `load`. | `results/loader.json` → `info`; every B and C answer |
| config | `"worker_loaders": [{ "binding": "LOADER" }]` and nothing else. Children ran with `globalOutbound: null`, `ctx.exports` stubs in `env` (B's gates, the probe's `HarnessDb`), and `{ wasm: ArrayBuffer }` modules. | `dist/*/wrangler.jsonc` (build.mjs) |
| plan | "currently only available on the Workers Paid plan" | [pricing](https://developers.cloudflare.com/dynamic-workers/pricing/), fetched 2026-10-25 |
| pricing | 1,000 unique Dynamic Workers a month included, then $0.002 per Dynamic Worker per day. "Uniquely identified by its Worker ID and code"; the tally "resets daily". Requests and CPU are billed at standard Workers rates. Dynamic Worker CPU includes "the compute required to initialize the isolate and parse your code". Each RPC method call on a Dynamic Worker stub is a billed request. | same |
| observed billing unit | `distinctDynamicWorkerCount` in `workersInvocationsByOwnerAndScriptGroups`: **223** for 2026-10-25, with 1,209 Dynamic Worker invocations using 7.3 CPU-s. Before the run the account had none this month. | `results/analytics.json` |
| documented limits | The API reference states no limit on dynamic Workers, code size, modules or isolates per loader. `developers.cloudflare.com/dynamic-workers/limits/` is a 404. | [api-reference](https://developers.cloudflare.com/dynamic-workers/api-reference/), fetched 2026-10-25 |
| observed limits | No refusal over the run: 120 distinct 100 KB children loaded in one request (each about 20 ms cold), then all 120 reused warm (`results/evict-many.json`). Children of 850 KB of code loaded fine. | below |
| runtime compilation | `WebAssembly.compile()` throws "Wasm code generation disallowed by embedder", as in local workerd. WASM must arrive as a module (`CompiledWasm`, or `{ wasm }` for a child). | `results/jspi.json` → `probe.runtimeCompile` |

## 2. Linker B on Workers

`x-forge-link-ms` is host-side wall time from the request to the child's answer. On deployed Workers the
timers advance only across I/O, so this is time spent waiting on the unit store, the loader, the child and
D1, not CPU. B and its D1 are in different regions (ORD and ENAM), so every D1 statement is a round trip
between them. Each statement is one RPC from the child to the host's `D1Gate` (T4). Runs 2 and 3 are
`results/b.run2.json` and `results/b.run3.json`. A first run, overwritten by run 2, is quoted only where
it showed something the files do not.

| | local T4 (workerd, loopback) | **deployed, host link ms** | deployed, client ms (median) |
| --- | --- | --- | --- |
| warm read `GET /v1/customers` | median 3.5 ms client, 2 ms host (n=30) | **median 28 / 35 ms** (runs 2/3, n=30 each), p95 42 / 57 | 76 / 87 |
| warm write `POST /v1/customers` | n/a | **median 80 / 100 ms**, p95 213 / 140 | 132 / 172 |
| warm `POST /v1/orders` | n/a | **median 151 / 162 ms** | 200 / 222 |
| warm write with units, `POST …/submit` (2 js units) | median 13.7 ms client, 6 ms host (n=10) | **median 148 / 203 ms** | 203 / 282 |
| **loader miss in a warm host isolate** (new child id from a salted kit; `GET /v1/customers`) | first request 32.5 ms (31–46) | **458–758 ms** (n=7 over runs 1–3) | |
| of which, fetching and verifying the child's blobs from R2 (`buildMs`) | median 5 ms (3–18) | **246–614 ms** (n=20 request-child builds; the dispatch child 501–922, n=5) | |
| the same loader miss, write (`POST /v1/customers`) | | 448–600 ms | |
| the same, submit | 44 ms cold | 598–889 ms | |
| **first request on a fresh host isolate** (pointer, kit, manifest and link from R2, then the child) | n/a | **1,760–2,323 ms** (n=6, `GET /v1/sites`, `results/eviction-b.json`) | |
| link the acme manifest (`PUT /_linker/manifest`) | 29 ms | 2,032 ms (and 2.4–3.1 s per re-link) | |
| a bare child's cold start in the loader, by code size (probe, no unit store) | n/a | 0 KB: 19 ms; 100 KB: 15 ms; 850 KB: 30 ms; warm: 3 ms | |

What the cold path costs, deployed. A loader miss costs 0.45–0.9 s, and most of it is the unit store.
Each child build reads and digest-checks about 850 KB in 4–7 R2 objects. That took 246–614 ms, against 5 ms
locally. Starting the isolate itself is cheap: a bare 850 KB child starts in 30 ms (`results/loader.json`).
acme's real child also evaluates Effect and the runtime and parses `app.json`. That remainder was not
separated per request, because `/_linker/stats` reports build times per host isolate, not per request.
Caching blobs closer than R2 matters more than the loader: the Cache API, or the code itself in KV.

A fresh *host* isolate costs about 2 s before its first answer. `current()` reads the pointer, the kit and
the manifest. `link()` then checks that every blob exists (one R2 `head` each), and fetches and parses the
548 KB app bundle. Only then is the child built. The tier host showed the same: its first dynamic request
had a host link time of 2,952 ms, and its first submit 1,126 ms (`results/c.json` → `first`).

### Swap and multiple host isolates

**Deployed, B's host runs as several isolates at once, and each holds its own manifest.** Sequential
requests from one client alternated between two host isolates (`91a0e8df`/`179d1b6d` in run 1,
`c284cc9d`/`e69f8fd2` in run 2). `PUT /_linker/manifest` and `PUT /_linker/kit` reach only the isolate that
serves them. An isolate that already holds a manifest never re-reads the pointer (`current()` caches it in
module scope).

- **Run 1.** After the swap (AuthorizePayment's limit 1000 → 2000), all 6 submits of a 1501.00 order
  landed on the other isolate. They answered 409 PaymentDeclined from the **old** closure `e54a47a4…`. The
  swap had not reached that isolate.
- **Runs 2 and 3.** Submits landed on a *fresh* isolate. It read the new pointer and answered 200 Submitted
  from the new closure `3e58e103…`. The first such request was cold (836 ms), and the next ones were warm
  (150–200 ms).
- **On the isolate that took the PUT**, closures the swap did not touch stayed warm in run 3: `GET
  /v1/customers` was 35 ms and `POST /v1/customers` 88 ms. As in T4, one module blob changed (464–836 ms to
  upload over the three runs) and 6 entry points got new closure hashes.
- **Linker C showed the same.** After the broken manifest was replaced with the sealed one, the next submit
  still fell back with `LoadFailed`. It reached a tier-host isolate that held the broken manifest.

This settles T4's design question 6. The pointer cannot live in isolate memory. A deployed host must check
it per request, with KV and a short TTL, or with a Durable Object, or by stamping the manifest hash into
the request path. Until then a swap is eventually consistent, with no bound. The salted re-links used for
cold samples were affected in the same way: several "cold" samples came back warm because the re-link had
landed on another isolate. The tables above count only samples that were cold.

### Eviction

| how | result |
| --- | --- |
| idle gaps of 0, 15, 60, 180, 600 and 1,200 s between single requests (B and the probe) | **every request landed on a fresh parent isolate** (`ageMs: 0`), even after 0 or 15 s, so every child was cold. For a low-traffic Worker, parent isolates are not reused between requests seconds apart; with back-to-back traffic two isolates alternated. (`results/eviction-b.json`, `results/eviction-loader.json`) |
| one request holding the parent isolate alive, re-hitting one child after a gap (`/loader/hold`) | **children are evicted after 10–20 s idle while their parent lives.** Warm after 1–9 s (2 runs), and after 10, 11, 12 and 15 s (2 runs). Cold after 10 s in one run. After 20 s it was cold in one run and warm in the other. Cold after 30, 60 and 120 s. (`results/eviction-hold.*.json`) |
| 120 distinct 100 KB children in one isolate, then all re-hit | **no capacity eviction**: 120 cold, then 120 warm (median 3 ms) |
| memory | not observable: neither analytics nor the runtime report isolate memory (only an `exceededMemory` outcome, which never occurred) |

## 3. Linker C: tiered router to a dynamic closure, a packed one, and the fallback

Router and tier times are host-side, from the lab gate around each Worker: the router includes the tier
host or packed script it called. `results/c.json` and `results/c-nomanifest.json`.

| | local R3 (one Miniflare, about 90 workers, noisy) | **deployed router ms (median, n)** | deployed tier host ms | client ms (median) |
| --- | --- | --- | --- | --- |
| `GET /v1/customers`, packed (router → packed script) | 44.4 ms client (p95 162) | **30** (n=30; p95 46) | | 90 |
| `POST /v1/orders`, dynamic, warm | 33.5 ms client (p95 100) | **176** (n=15) | 167 | 225 |
| `POST …/submit`, dynamic, warm | 45.9 ms client (p95 105) | **175** (n=15; p95 241) | 166 | 322 |
| `POST …/submit`, dynamic, first request (fresh tier isolate, cold child) | 91.9 ms | 1,147 | 1,126 | 1,406 |
| `POST /v1/orders`, dynamic, first request after seeding | | 3,040 | 2,952 | 3,274 |
| `POST …/submit`, **packed-fallback `LoadFailed`** (the AuthorizePayment module throws while it is evaluated) | 33.5 ms client (p95 131) | **188** (n=10; p95 2,725) | | 346 |
| `POST /v1/orders`, **packed-fallback `NoManifest`** (tier host empty, packed scripts just deployed) | | 372 (n=10) | | 567 |

- **Every answer carried the header the design specifies.** Packed reads said `x-forge-tier: packed`.
  Dynamic writes said `dynamic`, with `x-forge-isolate`. Fallbacks said `packed-fallback`, with
  `x-forge-tier-miss: LoadFailed` or `NoManifest`. All 10 `LoadFailed` fallbacks answered 200 Submitted
  (the packed limit). The router answered no 502.
- **The tier host's router hop.** Router minus tier is 9 ms for a dynamic request. A warm dynamic write in C
  (166 ms tier) is in the same range as B's (148–203 ms). The two share code, and both are bound by D1 round
  trips from ORD to ENAM.
- **The fallback costs the refused trip plus the packed request.** `LoadFailed` needs the child probe
  (`Forge.ping`) to fail first. One sample paid a fresh tier isolate (2.7 s), which is the p95.
- **The router's in-memory counters are per isolate and cannot be trusted deployed.** The
  `GET /_forge/tiered/stats` answer came from an isolate that had served 11 dynamic requests and no
  fallbacks, while other isolates had served the 10 fallbacks. Its `since` is `1970-01-01T00:00:00Z`,
  because `new Date()` runs at module scope, where the clock reads 0 on Workers. R3 expected Analytics
  Engine to be needed here; this confirms it.
- **There is no clean packed baseline for writes in the cut.** The packed write scripts were reachable only
  through fallbacks, so their times include the refused trip to the tier host. The packed read through the
  router took 30 ms. B's warm dynamic read took 28–35 ms. A warm write in B took 80–100 ms
  (`POST /v1/customers`, 2–3 D1 statements over RPC).

## 4. JSPI on deployed Workers

**It works deployed, with no flag, at compatibility date 2026-09-25, both in a static Worker and inside a
Dynamic Worker.** `results/jspi.json`.

- **Raw JSPI.** `WebAssembly.Suspending` and `WebAssembly.promising` exist. A real suspension (an import
  that awaits `scheduler.wait`) returns 41.
- **PriceCart** (`examples/pricing`, the Rust component with a JSPI-lifted `Product read` import) ran over
  D1 through the units harness's own modules (`bindUnit`, `D1_RESOURCE_HOST`, the FORG-41 pool). 1-, 10- and
  100-item carts all answered `ok`. A 10-item cart run 20 times in sequence on one isolate gave ok
  (`bench`).
- **QuoteOrder** (pure, no imports) answered `ok`.
- **In a Dynamic Worker.** The same modules, with the component's core modules passed as `{ wasm }` and
  D1 reached through a `ctx.exports` stub, gave the same answers. The child's first call was cold (55 ms
  for PriceCart, 35 ms for QuoteOrder).

| PriceCart, host ms (median of 9 warm) | local R2 (workerd, local D1), wasm | **deployed, static** | **deployed, in a Dynamic Worker** |
| --- | --- | --- | --- |
| 1 item | 2.1 ms | 14 ms | 20 ms |
| 10 items | 14.2 ms | 149 ms | 191 ms |
| 100 items | 160.5 ms | 1,513 ms | 2,065 ms |
| QuoteOrder | | 0 ms (no I/O, clock does not advance) | 5 ms |

About 15 ms per item, deployed: each read is one sequential D1 round trip from ORD to ENAM, so this is D1
latency, not JSPI. In a Dynamic Worker each read also crosses an RPC to the parent, which adds about 5 ms
per read here. Batching or prefetching reads (R2's option 3) matters more deployed than it did locally.

## 5. The 32-invocation limit

The probe (`lab/probe.js` → `lab/rpc-callee.js`, `results/rpc.json`) varied one thing at a time, each in a
single request.

| shape | result |
| --- | --- |
| n **sequential top-level** RPC calls to a service binding | fine at 10, 31, 32, 33, 40, 64, 100, 500, **1,000** |
| n sequential `fetch()` calls to a service binding | fine at 31–40 |
| one call; the callee calls back into an **`RpcTarget` stub** passed as a parameter, n times | fine at 10–1,000, **5,000** |
| the same with a **function stub** | fine at 40 and 100 |
| FORG-42's shape: `top` × `serve(caps)`, each making 40 capability callbacks | fine up to 40 serves (1,600 callbacks) |
| a ping-pong chain: callee → callback into the caller → a fresh call to the callee, n times | fine at 40 |
| **nested** invocations: each hop calls the next through a loopback service binding, Workers RPC (`/rpc/depth`) or `fetch` (`/rpc/fdepth`) | **fine at 30 hops; 31 throws "Subrequest depth limit exceeded. This request passed through too many Workers stages…"**, for RPC and fetch alike |

**What counts is nesting depth, not the number of calls.** 30 hops below the probe is 32 Workers stages:
the probe, the first `Hop`, and 30 more. The 33rd stage is refused. Calls made one after another do not
add up, and neither do callbacks into stubs. A callback runs in the caller's own stage, so a call made from
inside it starts again at the caller's depth. This is what made the ping-pong chain safe at 40.

**What this means for FORG-42's `InvocationBudget`.** The budget counts every cross-script call of a shared
request and refuses the 30th. Measured deployed, that guards against a limit the shared strategy cannot
reach. The deepest chain it makes is router → packed script → runtime Worker → (callback, same stage) →
dispatch owner: 4 stages. Its p95 of 11 and maximum of 20 calls are sequential, not nested.

**Recommendation (not changed in this PR).**

1. Replace the call counter with a depth guard. Fail closed if a request would nest more than about 28
   stages, which the shared strategy never does. Alternatively keep the counter as a runaway-loop guard
   with a much higher default, such as the Paid subrequest limit.
2. Then the in-process rule for budget reasons can go. Queue consumers, crons and the workflow start and
   signal routes were kept in process only because "the link cannot bound" their calls. Moving them shared
   recovers about **0.77 MB** of deploy bytes (6,643,972 B against 7,417,292 B in R3) and 3 of the 6
   re-uploaded scripts for a one-body edit. The workflow class, the realtime object, the upgrade route
   and the dispatch owner stay in process, for their own reasons.
3. The **subrequest** limit still applies to each call ("each request to a Worker via a Service binding
   counts toward your subrequest limit"; Paid 10,000 by default). Here 1,000 sequential calls and 5,000
   callbacks passed, so a budget at that scale would be the honest one.

This rests on one Worker, one account and one date. The docs still say "a maximum of 32 Worker
invocations", so the behaviour could change without notice. That is a reason to keep a depth guard.

## 6. Costs

From `results/analytics.json` (GraphQL `workersInvocationsAdaptive` per lab script, and
`workersInvocationsByOwnerAndScriptGroups` for Dynamic Workers), 15:40–17:31 UTC:

| | requests | CPU | notes |
| --- | --- | --- | --- |
| lab Workers (9 scripts) | 9,464 (126 `scriptThrewException`: the depth probe's refusals and 2 router 500s) | 15.9 CPU-s | B's host: p50 0.7 ms, p99 26 ms CPU per request; tier host p99 49 ms; packed scripts p50 3.6–9.2 ms |
| Dynamic Workers | 1,209 invocations | 7.3 CPU-s (6 ms per invocation on average, isolate startup included) | **223 distinct Dynamic Workers** for the day |
| D1 `forge-lab-acme` | 2,781 read and 3,650 write queries, 7,135 rows read, 7,563 written | | |
| D1 `forge-lab-pricing` | 2,420 read and 101 write queries | | |

**Estimate.** At overage list prices this is **$0.45**: $0.0032 in requests, $0.0005 in CPU and $0.446 in
Dynamic Workers. Every figure is inside the Workers Paid inclusions. The Dynamic Workers are 22% of the
1,000 a month included, and the account had used none this month. Requests are 0.1% of 10M and CPU 0.08%
of 30M ms. So the run's marginal charge is **$0** unless the account's other usage already exceeds the
inclusions. D1, R2 (42 objects) and the queue were far below their free allowances; nothing was consumed
from the queue. Cost per Dynamic Worker is the number to watch: each salted re-link created about 5 new
ones. A real deploy creates one per changed closure per day, plus one per host isolate that loads it.

## ForgeGraph and Cloudflare gaps

**ForgeGraph**

1. **A stage with deployment history cannot be removed.** `forge stage rm staging` answers 500, and
   `forge target remove` answers 409 ("still referenced by N deployments"). No CLI command or API removes
   or archives deployment records. **The `staging` stage of forge-console is still on the server.** Its 9
   targets were retired: each `buildCommand` now echoes "FORG-38 lab retired" and exits 1,
   `deployCommand` is `exit 1`, `syncSecrets` is false and its secrets are removed. A stray deploy fails
   before anything uploads. Removing it needs a ForgeGraph change: cascade, or archive stages and targets.
2. **Stage names are an enum.** `lab` is refused, and `development` scopes secrets per developer.
3. **The CI gate needs a changeset.** CI runs on `pull_request` and `push: main`. A `workflow_dispatch` run
   on the branch passed (Forgejo run 27181 on `a228fdc`), but ForgeGraph attaches builds to changesets
   only, so `forge deploy create --ref <branch>` reported "no CI run found". The lab deploys used
   `--break-glass`, which `--ref`'s help describes as the usual pairing for deploying a branch to a
   non-production stage.
4. **FG_COMMIT_HASH is stamped only into a wrangler config in appDir before the build.** A config the build
   writes elsewhere has no source identity. The first deploy then succeeds, and the source-order guard
   refuses every later one ("serving version … has no immutable FG_COMMIT_HASH; reconcile its source"),
   with no recovery command. `build.mjs` now stamps it. The probe, already deployed without it, was deleted
   with wrangler and deployed again.
5. **ForgeGraph never deletes a Worker** for a stage or target. Only PR previews and the traffic router call
   `deleteWorkerScript`. The lab scripts were deleted with `wrangler delete`.
6. `forge target list <stage>` silently ignores the positional and lists production. The flag is `--stage`.

**Cloudflare**

1. Linker B's state per host isolate (manifest pointer, kit, code cache) makes swaps eventually consistent,
   with no bound, because several host isolates serve at once (section 2). This is a design issue to fix
   in B, not a platform bug, but local workerd never shows it.
2. GraphQL `workersInvocationsAdaptive` with `scriptName_in` reports scripts it has not yet mapped as
   `__unknown__`. A `scriptName` filter on each script works.
3. No per-invocation memory, and no per-child attribution of Dynamic Worker CPU. Dynamic Worker usage is
   account-wide, by day.
4. The documented "32 Worker invocations per request" is, as measured, a nesting depth of 32 stages
   (section 5).
5. `dynamic-workers/limits/` is a 404.

## Created and deleted

All times are UTC on 2026-10-25. Workers were deployed by ForgeGraph and deleted with `wrangler delete`;
ForgeGraph has no delete. Resources were created and deleted with wrangler. The last check was at 17:31:16
through the Cloudflare API: **no `forge-lab-*` Worker scripts** (273 scripts on the account, the same as
before the run, `forge-console` present), and no `forge-lab*` D1 databases, R2 buckets or queues.

| when | what |
| --- | --- |
| 15:37:21 – 15:38:04 | wrangler created D1 `forge-lab-acme` (`01a45cda…`, ENAM) and `forge-lab-pricing` (`fe9b54dd…`, ENAM), R2 `forge-lab-units-b` and `forge-lab-units-c`, and queue `forge-lab-acme-fulfill-order` (`3e837e79…`) |
| 15:38:46 | wrangler applied acme's D1 migrations 0001–0006 to `forge-lab-acme` |
| 15:38:58 | `forge apply`: stage `staging` (sortOrder 90, id `92d6099c…`) and 9 targets |
| 15:39:41 | `forge secret set` LAB_TOKEN, LINKER_ADMIN_TOKEN, TIER_STATS_TOKEN, CURSOR_SECRET `--stage staging` (random values, kept only in a local file outside the repository) |
| 15:48 – 16:18 | `forge deploy create staging --ref FORG-38-paid-measurement --break-glass --target <t>`, one target at a time (deployments above) |
| 16:28 | probe redeploy refused by the source-order guard (`5695c9fa`) |
| 16:30:50 | `wrangler delete forge-lab-probe`; redeployed by ForgeGraph at 16:30:57 (`c750939b`) and 17:10:46 (`3014a42f`) |
| 16:19:50 – 17:25:33 | measurements |
| 17:27:41 – 17:28:01 | `wrangler delete` of all 9 `forge-lab-*` Workers |
| 17:28 – 17:29:25 | 30 and 12 objects deleted through the R2 API; `wrangler r2 bucket delete` for both buckets, `wrangler d1 delete` for both databases, `wrangler queues delete` |
| 17:29:32 – 17:29:34 | `forge secret rm` for the 4 staging secrets |
| 17:29:44, 17:30:05 | `forge stage rm staging`: 500 (ForgeGraph gap 1) |
| 17:30:47 – 17:31:01 | `forge target update <t> --stage staging`: the 9 targets retired |
| 17:31:37 | removed the lab's cargo cache `/mnt/master-apps/cache/forg38-lab-cargo` (1.5 GB) on hetzner-master |

## Not measured

- Isolate memory: not reported by the platform.
- A clean packed-only write baseline in C, because the cut reaches packed writes only through fallbacks;
  and today's whole-app Worker deployed.
- Cron, queue-consumer and Workflows entry points through B or C: not deployed in the cut.
- Placement effects: one colo (ORD), one client location, D1 in ENAM. With D1 in the Worker's region,
  every D1-bound number above would drop.
- Child CPU per closure: Dynamic Worker CPU is reported per account and day only.
