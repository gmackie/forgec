# R3: Stop paying the runtime per packed script

Research spike for FORG-42, following [R2, the runtime split](../r2-runtime-split/README.md) (FORG-37),
[R2, coverage](../r2-coverage/README.md) (FORG-33) and [T3, linker A](../t3-linker-packed/README.md)
(FORG-29). After the split, linker A's `per-entry-point` still put about 235 KB of runtime core plus
Effect into each of its 87 scripts. The median script was 285,719 B raw (82,560 B gzip), and the deploy
was 25.94 MB (7.40 MB gzip), about 48× a single Worker. This spike measures three ways not to pay that
per script, and adopts one of them as a working strategy, **`per-entry-point-shared`**.

Branch off main `479be5c`. Everything ran locally. Nothing was deployed.

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
5. Traces RPC callbacks over the whole suite (`rpc-trace.ts` → `results/rpc-trace.json`).

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
   - Passing bindings themselves over RPC: probed, not relied on, because it is undocumented.

## Results

`results/measure.json`. Per-script figures are min / median / max over the group scripts. The deploy
total includes the router and, for the shared strategies, the runtime Worker.

| | scripts (uploads) | raw per script | gzip per script | deploy raw / gzip | body edit re-uploads (raw / gzip) | scripts carrying the engine / Effect |
| --- | --- | --- | --- | --- | --- | --- |
| `single` | 1 (1) | 542,264 | 116,235 | 542,264 / 116,235 | 1 script, 542,264 / 116,236 | 1 / 1 |
| **`per-entry-point` (baseline)** | 87 (88) | 247,110 / 285,719 / 541,032 | 78,796 / 82,560 / 115,665 | 25,941,622 / 7,400,600 | 6 scripts, 1,845,816 / 532,147 | 87 / 87 |
| **`per-entry-point-shared` (adopted)** | 87 (89) | **10,025 / 48,863 / 332,830** | **3,752 / 7,358 / 95,707** | **6,643,972 / 1,269,403** | 6 scripts, **1,225,363 / 344,543** | 4 / 10 |
| change vs baseline | | −96% / −83% / −38% | −95% / −91% / −17% | **−74% / −83%** | −34% / −35% | |
| `per-resource` (approach 3, sized only) | 25 (26) | 247,110 / 292,201 / 541,032 | 78,796 / 85,074 / 115,665 | 8,169,270 / 2,230,549 | 6 scripts, 1,873,605 / 537,277 | 25 / 25 |
| `per-resource-shared` (sized only) | 25 (27) | 10,071 / 80,740 / 332,830 | 3,753 / 9,139 / 95,707 | 3,635,690 / 801,818 | 6 scripts, 1,238,603 / 345,469 | 4 / 9 |
| Effect reduction (approach 2) | | at most −434 B per script | | | | |

Against a single Worker, the shared deploy is 12× in raw bytes and 11× gzip. Per-entry-point was 48×
and 64×. The runtime Worker is 305,624 B (97,505 gzip): runtime 209,457, Effect 92,446 and host 3,501.

**Latency in local workerd, and the extra RPC cost** (`measure.json` → `latency`, in ms, median /
p95). The client times over loopback.

- *Cold* is the first request on a fresh Miniflare instance, over 7 fresh instances each for the read
  and the write.
- *Warm* is 100 requests per target. All three targets are served at the same time and the requests
  interleave across them, so load on the machine (other agents were running) hits them alike.
- *Paired* is the median of request-by-request differences from per-entry-point.

The read is `GET /v1/customers/{id}`, the write is `POST /v1/customers`, and the write with units is
`POST /v1/orders/{order}/submit` (2 js units, 1 transition, 1 external).

| | instance start | cold read | cold write | warm read | warm write | warm write with units | paired vs per-entry-point (read / write / units) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `single` | 1,266 | 53.8 / 168 | 84.6 / 108 | 9.4 / 20.4 | 13.1 / 30.4 | 17.9 / 29.8 | −0.9 / −0.8 / −1.3 |
| `per-entry-point` | 6,541 | 68.4 / 87.3 | 80.2 / 109 | 10.4 / 25.3 | 14.1 / 43.2 | 21.4 / 33.1 | 0 |
| `per-entry-point-shared` | 4,638 | 72.3 / 91.1 | 77.1 / 139 | 10.0 / 22.8 | 14.7 / 35.4 | 19.8 / 32.3 | **+0.3 / +0.5 / −0.2** |

An earlier run of the same harness, on a busier machine (not kept in the JSON), gave paired
differences of +0.6 / +2.2 / +7.4 ms, and shared cold requests +11 ms (read) and +33 ms (write) over
per-entry-point. **Local workerd does not resolve the RPC cost below a few milliseconds of noise.** What
it can bound:

- **RPC calls per request** (`measure.json` → `crossings`, counted in Node with the same modules):
  - a read is 2: one call to the runtime and one D1 statement back;
  - a write is 3, plus a one-off `slice` fetch per runtime isolate and slice;
  - the write with units is 7, plus `slice`: invoke, external, 3 D1 statements and a batch.
- **One call costs about 0.1 ms locally** (`rpc-probe.json`): 200 calls from the script to the runtime
  took 22 ms, and 200 callbacks into the script took 4 ms. Same-thread execution on Cloudflare
  (below) makes the deployed cost plausibly lower. That is not verified.
- **Cold:** a shared script's first request also starts the runtime Worker's isolate and fetches its
  slice, so cold requests should cost more on Cloudflare. That is not measured here: locally, workerd
  compiles every script when the instance starts. Instance start itself is faster with fewer engine
  copies to compile (4.6 s against 6.5 s for 88 scripts).

**Approach 2, Effect** (`measure.json` → `effect`). The CRUD read script on per-entry-point carries
92,378 B of Effect across 51 modules. Of that, `internal/effect.js` is 38,266 B and `Effect.js` is
7,293 B. Effect's floor, bundled the same way:

- `Effect.runPromise(Effect.succeed(1))`: 85,356 B.
- A service through a `Layer`, which is what the engine needs: 91,944 B.
- A js unit's own imports (`Effect.gen` and `defineFunction`): 85,435 B.

That leaves **434 B above the floor**, so there is nothing to cut without stopping running requests
through Effect, which would be a rewrite. FORG-37 reached the same conclusion. It is not pursued. The
shared runtime is what removes Effect: 77 of the 87 scripts carry none at all.

## Design: `per-entry-point-shared`

Code: `packages/linker-packed/src/shared/`. The strategy is registered in `strategies.ts`, and the
hooks in `link.ts` and `local.ts` are a few lines each.

```
client ─► router ─(service binding)─► packed script ─(FORGE_RUNTIME, Workers RPC)─► runtime Worker
                                       routes, slice,        ▲ serve(request, caps, meta, values)
                                       units, bindings       │
                                       caps (RpcTarget) ◄────┘ d1 / r2 / queue / workflow / durable,
                                                               invoke(unit) / external, slice()
```

- **Grouping, slices, narrowing and features are per-entry-point's, unchanged.**
  `test/shared.test.ts` checks that both links agree on every script's members, routes, injected and
  withheld bindings, features and slice.
- **A shared script** (`shared/script.ts`, about 4 KB) does the following:
  - routes exactly as `host.ts` does (`NotRouted`, method-miss to the path owner, residual deny);
  - forwards first-sight tenants and post-commit work to the dispatch owner over `FORGE_DISPATCH`, as
    before;
  - calls `FORGE_RUNTIME.serve(request, caps, meta, values)`.

  `caps` is an `RpcTarget` whose every method takes a binding *name* and checks it against the name
  and type the link injected. It is the runtime's only way to a binding. Secrets and vars travel by
  value. A script imports no runtime code unless it holds a js-module unit (`shared/units.ts`).
- **The runtime Worker** (`shared/runtime.ts`, `<package>-runtime`) has **no bindings and no app
  code** (its `wrangler.jsonc` is name, main and compatibility date). It does the following:
  - caches slices per isolate by hash, and re-checks a fetched slice against its hash;
  - builds a Worker per call with `createWorkerWith(slice, { features: <the script's>, objects? })`;
  - gives the engine an env of facades over `caps`, plus refusing stubs for the script's withheld
    bindings.

  It holds no app code, so app edits never re-upload it (`bodyEdit`: the runtime is not among the 6).
  Building the Worker per call is cheap, because `Model` is lazy: under 0.05 ms per slice in Node.
- **Capability narrowing stays per script, by construction.**
  - The runtime can reach only what the calling script hands over, because it has nothing of its own.
  - A binding declared for another script is a refusing stub built from the script's `withheld`, so
    it answers 403 `CapabilityDenied` (`binding:r2:BLOBS`), exactly as FORG-34. Tested in
    `test/shared.test.ts`: the declared bucket gives 422, the withheld bucket gives 403, and `caps`
    refuses any name or type the script was not linked with.
  - A slice that does not match its hash is refused.
- **Unit code runs where its bindings are**, in the script.
  - The runtime registers proxies for the script's units. A proxy calls `caps.invoke(id, input, ctx,
    deps, shape)` with `deps` as an `RpcTarget` over the engine's real `FunctionContext`.
  - The script rebuilds the same `deps`: the same resources, transitions and methods, each an Effect
    that crosses back and keeps typed `ForgeError` failures.
  - `transactional` comes from the unit module itself, which the link cannot see, so the script
    reports it.
  - Externals run in the script.
- **Outbox dispatch is FORG-29/30's, unchanged.**
  - The dispatch owner (`forge:sweep`) keeps its in-process host and sweeps for everyone.
  - A shared script's `postCommit` does not sweep. The runtime returns the committed tenants with the
    response, and the script forwards them to the owner over `FORGE_DISPATCH` in `waitUntil`, as
    `host.ts` did.
  - This is forced by the RPC lifecycle: parameter stubs are disposed when the call returns, so the
    runtime cannot use `caps` in a `waitUntil`. Measured in the probe: "RPC stub used after being
    disposed". So the runtime awaits the engine's other `waitUntil` work, such as schedule-index
    tracking, before it returns.
  - Queue batches return per-message ack or retry, and `scheduled` awaits its sweeps.
- **Four groups keep the in-process host** (`link.json` → `scripts[].runtime.reason`):
  - the Workflows class (`WorkflowEntrypoint.run` drives the engine with the platform's `step`);
  - the realtime Durable Object;
  - the WebSocket upgrade route (a 101 with a socket cannot cross RPC);
  - the dispatch owner.

  Together they are 1.21 MB of the 6.64 MB deploy.
- **What a shared script still carries:**
  - its slice, which is most of it. The read script is 21,148 B, of which 16,089 is the slice. The
    three contract-metadata scripts carry the whole `app.json` (233 KB) and are the shared maximum
    (238,112 B);
  - Effect, in the 6 shared scripts with js units (about 141 KB each), because sealed unit modules
    import Effect themselves (85,768 B). That is why the body edit still re-uploads 1.23 MB: 4 shared
    unit scripts at about 140–150 KB each, plus the in-process workflow class and sweep.

Changes outside `src/shared/`, all additive:

- `GroupingStrategy.runtime?` and the strategy registration;
- `LinkedScript.runtime?` and `Link.runtime?`, set only by shared strategies, so other links'
  `link.json` is unchanged;
- the new strategy added to `test/differential.test.ts`, only when it has been linked;
- `local.ts` serving the runtime Worker, plus an opt-in `FORGE_RPC_TRACE` var for research;
- `effect` as a dependency of `@forgegraph/linker-packed`, because the runtime and units modules import
  it (the lockfile gained 3 lines).

The runtime package's exports are unchanged, and `release:check` and `release:identities` pass.

Two things a shared script cannot do that an in-process one can:

- **Stream blob uploads.** R2 `put` needs a stream of known length, and a stream that crossed RPC has
  none. The first differential run failed `blobs` with "Provided readable stream must have a known
  length". The script now buffers the upload (bounded by the blob's `byteCount`, and the 128 MB
  isolate limit).
- **Stream responses.** The runtime also buffers the response body before returning, because it may
  be read from `caps`, which is disposed when the call returns.

## Correctness

`results/conformance.json`: the linker-A differential (`T3_DIFFERENTIAL=1`, `LINK_RESULTS` set here),
all 15 scenarios (221 steps) plus the realtime WebSocket check, one Miniflare instance per target.

| target | scripts | scenarios | realtime | unexplained differences from whole-app |
| --- | --- | --- | --- | --- |
| whole-app | 1 | 15 / 15 | pass | n/a |
| whole-app again (A/A) | 1 | 15 / 15 | pass | 0 (100 run-to-run positions) |
| `single` | 1 | 15 / 15 | pass | **0** |
| `per-entry-point` | 88 | 15 / 15 | pass | **0** |
| `per-entry-point-full` | 88 | 15 / 15 | pass | **0** |
| **`per-entry-point-shared`** | **89** (87 + router + runtime) | **15 / 15** | **pass** | **0** |

Counting rules are T3's.

## Workers limits this relies on

The Cloudflare docs below were fetched on 2026-10-24.

| what | finding | source |
| --- | --- | --- |
| What can cross RPC | Structured-clonable values, functions and `RpcTarget` subclasses (as stubs), byte `ReadableStream`s, `Request`/`Response`, and stubs. The capability object and `deps` are `RpcTarget`s. | developers.cloudflare.com/workers/runtime-apis/rpc/ |
| **Bindings as RPC values** | **Not documented.** Locally, passing `env.DB` to the runtime Worker works (`rpc-probe.json` → `useDb`). Not relied on: D1, R2, queues, workflows and DOs cross as facades over `caps`. | probe; the rpc page lists no bindings |
| Stub lifetime | "When stubs are received in the parameters of an RPC, those stubs are automatically disposed when the call returns" (`dup()` to keep one). Hence the dispatch hand-back and the buffering above. | …/rpc/lifecycle/; probe `lateResult` |
| Message size | "The maximum serialized RPC limit is 32 MiB." The largest slice is 233 KB, the whole contract. | …/rpc/ |
| Placement and latency | Smart Placement "is currently ignored when making RPC calls"; the called Worker "will run locally, on the same machine". Service bindings have "zero overhead or added latency", and "by default, both Workers run on the same thread". | …/rpc/; …/bindings/service-bindings/ |
| Cost | "Service bindings don't increase costs." | …/bindings/service-bindings/ |
| **Invocations per request** | "A single request has a maximum of 32 Worker invocations, and each call to a Service binding counts towards this limit." A shared request makes at least 3: router → script → runtime. **Whether a call on a stub received as a parameter (the runtime's callbacks into `caps`) counts is not documented.** Over the suite: median 2, p95 8, **max 33 callbacks** in one request (`POST /v1/orders/{id}/process`, which advances a workflow inline). 1 of 247 requests has more than 29 (`rpc-trace.json`). **Unverified.** | …/bindings/service-bindings/; `rpc-trace.json` |
| Subrequests | "Each request to a Worker via a Service binding counts toward your subrequest limit" (Paid: 10,000 by default; Free: 50). D1 queries count as subrequests either way. | …/platform/limits/; …/bindings/service-bindings/ |
| Workers per account | 500 on Paid, 100 on Free. The shared strategy adds 1 script (89 for acme). | …/platform/limits/ |
| Script size and startup | The limits page lists 64 MiB uncompressed and "no compressed size limit". Global scope must run within 1 s. The largest script is unchanged (the sweep, 332,830 B). | …/platform/limits/ |
| Memory | 128 MB per isolate, which bounds the buffered blob uploads. | …/platform/limits/ |

## Recommendation

**Adopt `per-entry-point-shared` as linker A's per-entry-point strategy.** It passes the differential
15/15 on every target with 0 unexplained differences. Against per-entry-point it:

- cuts the median script by 83% raw and 91% gzip;
- cuts the deploy by 74% raw and 83% gzip;
- cuts the bytes a one-body edit re-uploads by about a third;
- keeps per-script narrowing by construction, because the runtime has no bindings;
- leaves dispatch semantics as they were.

Warm latency is indistinguishable from per-entry-point locally. It is kept alongside `per-entry-point`
rather than replacing it, so the baseline stays measurable and FORG-43 can build on either.

Before production, in this order:

1. **Verify the 32-invocation limit on a deployed account.** Whether callbacks into a script count is
   what decides whether a workflow-start request survives. If they do count, there are three options:
   - batch the D1 statements of a read set into one callback;
   - pass the D1 binding to the runtime directly. This works locally but is undocumented, and it
     would remove most callbacks;
   - keep the workflow-start and signal routes in process, like the workflow class.
2. Measure cold start deployed. A shared script's first request also starts the runtime isolate. The
   isolate is shared, so it should be warm for most requests.
3. Decide whether to stream blob uploads: a FixedLengthStream sized from the upload intent would
   replace the buffering.

Further levers, measured but not adopted:

- **Per-resource grouping on top of shared** (`per-resource-shared`): 25 scripts and a 3.64 MB deploy
  (0.80 MB gzip), a further −45% raw. Each script then holds a resource-wide slice, and the median
  rises to 80,740 B. Not run through the differential.
- **Effect in unit scripts** (about 86 KB in each of the 6 shared scripts with js units). It would go
  only if the units' sealed modules stopped importing Effect, or if units ran against a non-Effect
  `deps`. That is a units API change.
