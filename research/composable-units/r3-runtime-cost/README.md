# R3: Stop paying the runtime per packed script

Research spike for FORG-42, following [R2, the runtime split](../r2-runtime-split/README.md) (FORG-37),
[R2, coverage](../r2-coverage/README.md) (FORG-33) and [T3, linker A](../t3-linker-packed/README.md)
(FORG-29). After the split, linker A's `per-entry-point` still put about 235 KB of runtime core plus
Effect into each of its 87 scripts. The median script was 285,719 B raw (82,560 B gzip), and the deploy
was 25.94 MB (7.40 MB gzip), about 48× a single Worker. This spike measures three ways not to pay that
per script, and adopts one of them as a working strategy, **`per-entry-point-shared`**.

The branch is off main `479be5c`, with main `63f8118` merged in (FORG-41 and FORG-43). All results below
are from the merged tree. Everything ran locally. Nothing was deployed.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm -r run build
bash research/composable-units/r3-runtime-cost/run.sh
pnpm --filter @forgegraph/linker-packed exec vitest run test/shared.test.ts
```

`run.sh` does the following, in order:

1. Builds forgec and the runtime, and seals acme.
2. Runs the RPC probe (`probe/` → `results/rpc-probe.json`).
3. Runs `measure.ts` (→ `results/measure.json`). It records sizes, deploy bytes, the bytes a one-body
   edit re-uploads, an Effect breakdown, RPC calls per request and workerd latency.
4. Links the differential targets and runs the linker-A differential with `LINK_RESULTS` set here
   (→ `results/conformance.json`).
5. Counts every request's cross-script calls over the whole suite (`rpc-trace.ts` →
   `results/rpc-trace.json`).

Bundling is FORG-29/37's: esbuild, minified, ESM, platform neutral, `cloudflare:*` and `node:*`
external, gzip -9. Machine: macOS arm64 (Apple M2 Max), Node 24.14.0, esbuild 0.27.7, miniflare
5.20260918.0-alpha (workerd 1.20260918.1), compatibility date 2026-09-01 (acme's own).

## The approaches

1. **A shared runtime Worker over service-binding RPC** (adopted: `per-entry-point-shared`). Packed
   scripts keep only their routing, units and slice. One runtime Worker does the engine work.
2. **Less Effect in the core paths a slice uses.** Measured with esbuild metafiles. Not pursued,
   because there is nothing safe to cut (below).
3. **Other credible options.**
   - Per-resource grouping (T3 open question 5): sized, alone and combined with 1. Not run through the
     differential.
   - Passing bindings themselves over RPC: probed, and rejected. It is undocumented, and it would
     weaken narrowing.

## Results

`results/measure.json`. Per-script figures are min / median / max over the group scripts. The deploy
total includes the router and, for the shared strategies, the runtime Worker.

| | scripts (uploads) | raw per script | gzip per script | deploy raw / gzip | body edit re-uploads (raw / gzip) | scripts carrying the engine / Effect |
| --- | --- | --- | --- | --- | --- | --- |
| `single` | 1 (1) | 542,424 | 116,269 | 542,424 / 116,269 | 1 script, 542,424 / 116,269 | 1 / 1 |
| **`per-entry-point` (baseline)** | 87 (88) | 247,270 / 285,879 / 541,192 | 78,831 / 82,595 / 115,697 | 25,955,542 / 7,403,746 | 6 scripts, 1,846,776 / 532,367 | 87 / 87 |
| **`per-entry-point-shared` (adopted)** | 87 (89) | **12,010 / 50,848 / 332,990** | **4,482 / 8,102 / 95,746** | **7,417,292 / 1,513,850** | 6 scripts, **1,698,785 / 487,451** | 8 / 10 |
| change vs baseline | | −95% / −82% / −38% | −94% / −90% / −17% | **−71% / −80%** | −8% / −8% | |
| `per-resource` (approach 3, sized only) | 25 (26) | 247,270 / 292,361 / 541,192 | 78,831 / 85,109 / 115,697 | 8,173,270 / 2,231,436 | 6 scripts, 1,874,565 / 537,497 | 25 / 25 |
| `per-resource-shared` (sized only) | 25 (27) | 12,056 / 82,725 / 338,645 | 4,484 / 9,885 / 95,746 | 4,300,433 / 1,004,517 | 6 scripts, 1,726,571 / 492,581 | 8 / 9 |
| Effect reduction (approach 2) | | at most −434 B per script | | | | |

Against a single Worker, the shared deploy is 14× in raw bytes and 13× gzip. Per-entry-point was 48×
and 64×. The runtime Worker is about 306 KB (97.5 KB gzip): runtime, Effect and the host.

**The cost of the invocation budget.** Eight groups keep the in-process host. Together they are
2,413,265 B of the 7.42 MB deploy:

- four that cannot leave their isolate: the workflow class, the realtime object, the upgrade route and
  the dispatch owner;
- four whose cross-script calls the link cannot bound (see the budget below): the workflow start
  route, the workflow signal route, the queue consumer and the cron.

Before this follow-up, only the first four stayed in process. The deploy was then 6,643,972 B
(1,269,403 gzip), and a one-body edit re-uploaded 1,225,363 B. The edit grows because three of the six
scripts it touches are now in process: the cron, and the start and signal routes.

**Latency in local workerd, and the extra RPC cost** (`measure.json` → `latency`, in ms, median /
p95). The client times over loopback.

- *Cold* is the first request on a fresh Miniflare instance, over 7 fresh instances each for the read
  and the write.
- *Warm* is 100 requests per target. All three targets are served at the same time and the requests
  interleave across them, so load on the machine hits them alike.
- *Paired* is the median of request-by-request differences from per-entry-point.

The read is `GET /v1/customers/{id}`, the write is `POST /v1/customers`, and the write with units is
`POST /v1/orders/{order}/submit` (2 js units, 1 transition, 1 external).

| | instance start | cold read | cold write | warm read | warm write | warm write with units | paired vs per-entry-point (read / write / units) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `single` | 827 | 47.7 / 55.9 | 66.1 / 81.5 | 7.6 / 16.2 | 10.5 / 19.3 | 15.9 / 30.6 | +0.3 / −1.8 / −2.0 |
| `per-entry-point` | 5,622 | 45.5 / 53.8 | 72.3 / 97.7 | 8.0 / 15.6 | 12.3 / 22.1 | 18.5 / 26.2 | 0 |
| `per-entry-point-shared` | 3,074 | 52.2 / 81.6 | 69.8 / 122 | 8.0 / 15.3 | 13.8 / 23.4 | 20.5 / 32.6 | **−0.3 / +1.1 / +2.7** |

Across the three runs of this harness, the paired differences were:

| run | read | write | write with units |
| --- | --- | --- | --- |
| first, before the merge, on a busy machine | +0.6 | +2.2 | +7.4 |
| second, before the merge | +0.3 | +0.5 | −0.2 |
| this run | −0.3 | +1.1 | +2.7 |

**Local workerd does not resolve the RPC cost below a few milliseconds.** What it can bound:

- **RPC calls per request** (`measure.json` → `crossings`, counted in Node with the same modules):
  - a read is 2: one call to the runtime and one D1 statement back;
  - a write is 3, plus a one-off `slice` fetch per runtime isolate and slice;
  - the write with units is 7, plus `slice`.
- **One call costs about 0.1 ms locally** (`rpc-probe.json`). Same-thread execution on Cloudflare
  makes the deployed cost plausibly lower. That is not verified.
- **Cold:** a shared script's first request also starts the runtime Worker's isolate and fetches its
  slice. That is not measured deployed. Locally, workerd compiles every script when the instance
  starts, and instance start is faster with fewer engine copies (3.1 s against 5.6 s).

**Approach 2, Effect** (`measure.json` → `effect`). The CRUD read script on per-entry-point carries
92,378 B of Effect across 51 modules. Of that, `internal/effect.js` is 38,266 B. Effect's floor, bundled
the same way:

- `Effect.runPromise(Effect.succeed(1))`: 85,356 B.
- A service through a `Layer`, which is what the engine needs: 91,944 B.
- A js unit's own imports: 85,435 B.

That leaves **434 B above the floor**, so there is nothing to cut without stopping running requests
through Effect, which would be a rewrite. It is not pursued. The shared runtime is what removes Effect:
77 of the 87 scripts carry none at all.

## Design: `per-entry-point-shared`

Code: `packages/linker-packed/src/shared/`. The strategy is registered in `strategies.ts`, and the
hooks in `link.ts` and `local.ts` are a few lines each.

```
client ─► router ─(service binding)─► packed script ─(FORGE_RUNTIME, Workers RPC)─► runtime Worker
                                       routes, slice,        ▲ serve(request, caps, meta, values)
                                       units, bindings,      │
                                       invocation budget     │
                                       caps (RpcTarget) ◄────┘ d1 / r2 / queue / workflow / durable,
                                                               invoke(unit) / external, slice()
```

- **Grouping, slices, narrowing and features are per-entry-point's, unchanged.**
  `test/shared.test.ts` checks that both links agree on every script's members, routes, injected and
  withheld bindings, features and slice.
- **A shared script** (`shared/script.ts`, about 5 KB) does the following:
  - routes exactly as `host.ts` does;
  - forwards first-sight tenants and post-commit work to the dispatch owner over `FORGE_DISPATCH`;
  - calls `FORGE_RUNTIME.serve(request, caps, meta, values)`.

  `caps` is an `RpcTarget` whose every method takes a binding *name* and checks it against the name
  and type the link injected. It is the runtime's only way to a binding. A script imports no runtime
  code unless it holds a js-module unit (`shared/units.ts`).
- **The runtime Worker** (`shared/runtime.ts`, `<package>-runtime`) has **no bindings and no app
  code**. It does the following:
  - caches slices per isolate by hash, and re-checks a fetched slice against its hash;
  - builds a Worker per call from the slice with the script's features;
  - gives the engine an env of facades over `caps`, plus refusing stubs for the script's withheld
    bindings.

  It holds no app code, so app edits never re-upload it.
- **Capability narrowing stays per script, by construction.**
  - The runtime can reach only what the calling script hands over.
  - A binding withheld from the script answers 403 `CapabilityDenied` (`binding:r2:BLOBS`), as
    FORG-34.
  - `caps` refuses any name or type the script was not linked with.
  - A slice that does not match its hash is refused.

  All of these are tested.
- **Unit code runs where its bindings are**, in the script.
  - It reaches the engine back through an `RpcTarget` over the engine's real `FunctionContext`.
  - Typed `ForgeError` failures survive the hop.
  - `transactional` is reported by the unit module itself.
- **Outbox dispatch is FORG-29/30's, unchanged.**
  - The dispatch owner keeps its in-process host and sweeps for everyone.
  - A shared request's committed tenant comes back with the response. The script forwards it to the
    owner in `waitUntil`, as `host.ts` did.
  - This is forced by the RPC lifecycle: parameter stubs are disposed when the call returns.
- **FORG-43's `advance` endpoint** (merged from main) coexists with the shared strategy. Only scripts
  holding a workflow class serve it, and they are in process. Tested: a shared link with
  `advance: true` gives exactly the workflow class the endpoint. Linker C links linker A with
  `per-entry-point`, which this change does not alter.

### The invocation budget: how the 32-invocation limit is guaranteed

Cloudflare caps a request at 32 Worker invocations, and "each call to a Service binding counts towards
this limit". It does not say whether a call on a stub received as an RPC parameter counts: the
runtime's callbacks into a script, and a unit's calls back into the engine. The guarantee therefore
does not depend on the answer. **Every shared request is counted as if every cross-script call were an
invocation, and the call that would be the 30th is refused** (3 in hand).

The count is `InvocationBudget` in `shared/script.ts`, one per request, queue batch or cron:

| counted | calls |
| --- | --- |
| the invocation that started it (the router's call, a batch, a cron) | 1 |
| the schedule-index hand-off to the dispatch owner, for a tenant this isolate has not seen | 1 |
| the post-commit hand-off, reserved before the runtime is called (any method but GET/HEAD) | 1 |
| the call to the runtime Worker | 1 |
| every callback the runtime makes into the script | 1 each |
| a Durable Object fetch | 2 (the callback and the object) |
| every `deps` call a unit in the script makes back into the engine | 1 each |

**Why this is a bound, not an estimate.** Every cross-script call of a shared request passes through
one of four places: `serve`, a `Capabilities` method, the counted `deps` wrapper, or a dispatch
hand-off. Each of them spends from the budget first. The runtime Worker has no bindings and no service
bindings, so it can invoke nothing except through the script. A refused call rejects, as it would
arrive over RPC. The request then fails closed, whatever the runtime made of the refusal:

- **An HTTP request** answers 500 `RpcBudgetExceeded`, retryable false. The detail names the refused
  call and the count, says whether a write had already committed, and is logged with
  `console.error`. The runtime's own answer is discarded.
- **A queue batch** throws, so every message is retried.
- **A cron** throws.

`test/shared.test.ts` checks three things:

- the 30th call is refused, and exactly 26 callbacks ran after the router's call, the hand-off and the
  runtime call;
- a unit's `deps` calls are counted and the post-commit hand-off is reserved (24 `deps` calls ran),
  with no post-commit hand-off for a failed request;
- an over-budget queue batch retries every message.

**What the link moves in process, so a request never meets the budget in normal use.** These entry
points do work per invocation that the link cannot bound, so they keep the in-process host
(`inProcessReason` in `shared/link.ts`):

- workflow start and signal routes: an HTTP route rooted at a workflow unit, which advances the
  instance inline;
- queue consumers: one invocation per batch of up to `max_batch_size` messages;
- crons: one invocation sweeps every due schedule of every tenant.

A link-time bound for the rest (option a) is not provable: D1 statements per request depend on data,
for example a changeset's size or the pages a rebuild lists. Those routes stay shared, under the
budget.

**The distribution over the suite** (`results/rpc-trace.json`). These are the 15 scenarios in local
workerd, counted exactly as the budget counts:

- 229 shared requests;
- invocations min 2, **median 5, p95 11, max 20**;
- **0 refused**;
- the heaviest are the schedule tick route (20), a changeset commit (17) and order submit (15).

The earlier figure of 33, for `POST /v1/orders/{id}/process`, counted callbacks only, not the starting
invocation, the runtime call, the hand-offs or unit `deps` calls. That route is now in process.

D1 reads were not batched into one callback. The engine's reads are sequential and depend on each
other, so batching would need an engine change. With a p95 of 11 against a budget of 29 it is not
needed.

### What a shared script cannot do

- **Stream blob uploads.** R2 `put` needs a stream of known length, and a stream that crossed RPC has
  none. The first differential run failed `blobs` with "Provided readable stream must have a known
  length". The script buffers the upload (bounded by the blob's `byteCount`, and the 128 MB isolate
  limit).
- **Stream responses.** The runtime buffers the response body before returning, because it may be read
  from `caps`, which is disposed when the call returns.

### Changes outside `src/shared/`

All additive:

- `GroupingStrategy.runtime?` and the strategy registration;
- `LinkedScript.runtime?` and `Link.runtime?`, set only by shared strategies;
- the shared target in `test/differential.test.ts`, only when it has been linked;
- `local.ts` serving the runtime Worker, plus an opt-in `FORGE_RPC_TRACE` var for research;
- `effect` as a dependency of `@forgegraph/linker-packed`.

Runtime package exports are unchanged.

## Correctness

`results/conformance.json`: the linker-A differential (`T3_DIFFERENTIAL=1`, `LINK_RESULTS` set here)
on the merged tree, all 15 scenarios (221 steps) plus the realtime WebSocket check, one Miniflare
instance per target.

| target | scripts | scenarios | realtime | unexplained differences from whole-app |
| --- | --- | --- | --- | --- |
| whole-app | 1 | 15 / 15 | pass | n/a |
| whole-app again (A/A) | 1 | 15 / 15 | pass | 0 (100 run-to-run positions) |
| `single` | 1 | 15 / 15 | pass | **0** |
| `per-entry-point` | 88 | 15 / 15 | pass | **0** |
| `per-entry-point-full` | 88 | 15 / 15 | pass | **0** |
| **`per-entry-point-shared`** | **89** (87 + router + runtime) | **15 / 15** | **pass** | **0** |

Counting rules are T3's. Linker C (FORG-43) still passes its own differential on the merged tree. All
six of its targets are 15/15, with 0 unexplained differences for packed, dynamic and tiered (run with
`LINK_RESULTS` outside this directory, so FORG-43's record is untouched).

## Workers limits this relies on

The Cloudflare docs below were fetched on 2026-10-24.

| what | finding | source |
| --- | --- | --- |
| What can cross RPC | Structured-clonable values, functions and `RpcTarget` subclasses (as stubs), byte `ReadableStream`s, `Request`/`Response`, and stubs. | developers.cloudflare.com/workers/runtime-apis/rpc/ |
| Bindings as RPC values | **Not documented.** Passing `env.DB` works locally (`rpc-probe.json` → `useDb`). Not used: it is undocumented, and it would hand the runtime a binding rather than a name-checked capability. | probe; the rpc page lists no bindings |
| Stub lifetime | "When stubs are received in the parameters of an RPC, those stubs are automatically disposed when the call returns." | …/rpc/lifecycle/; probe `lateResult` |
| Message size | "The maximum serialized RPC limit is 32 MiB." The largest slice is 233 KB. | …/rpc/ |
| Placement and latency | The called Worker "will run locally, on the same machine". Service bindings have "zero overhead or added latency", and "by default, both Workers run on the same thread". | …/rpc/; …/bindings/service-bindings/ |
| Cost | "Service bindings don't increase costs." | …/bindings/service-bindings/ |
| **Invocations per request** | "A single request has a maximum of 32 Worker invocations, and each call to a Service binding counts towards this limit." Whether stub callbacks count is not documented. **Guaranteed regardless:** the invocation budget counts them all and refuses the 30th. Over the suite the maximum is 20. | …/bindings/service-bindings/; `rpc-trace.json` |
| Subrequests | "Each request to a Worker via a Service binding counts toward your subrequest limit" (Paid: 10,000 by default). | …/platform/limits/; …/bindings/service-bindings/ |
| Workers per account | 500 on Paid, 100 on Free. The shared strategy adds 1 script. | …/platform/limits/ |
| Script size and startup | 64 MiB uncompressed; global scope within 1 s. The largest script is unchanged. | …/platform/limits/ |
| Memory | 128 MB per isolate, which bounds the buffered blob uploads. | …/platform/limits/ |

## Recommendation

**Adopt `per-entry-point-shared` as linker A's per-entry-point strategy.** It passes the differential
15/15 on every target with 0 unexplained differences. Against per-entry-point it:

- cuts the median script by 82% raw and 90% gzip;
- cuts the deploy by 71% raw and 80% gzip;
- keeps per-script narrowing by construction;
- leaves dispatch as it was;
- can no longer exceed the 32-invocation limit unnoticed.

Warm latency is indistinguishable from per-entry-point locally. It is kept alongside `per-entry-point`,
so the baseline stays measurable.

Still to do before production:

1. Measure cold start deployed.
2. Confirm on a deployed account whether stub callbacks count as invocations. If they do not, the
   in-process rule for queue consumers, crons and workflow start and signal could be relaxed, which
   would win back about 0.77 MB of deploy bytes.
3. Decide whether to stream blob uploads, with a FixedLengthStream sized from the upload intent.

Further levers, measured but not adopted:

- **Per-resource grouping on top of shared:** 25 scripts and a 4.30 MB deploy (1.00 MB gzip), not run
  through the differential.
- **Effect in unit scripts** (about 86 KB in each shared script with js units): this needs a change to
  the units API.
