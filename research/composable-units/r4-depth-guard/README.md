# R4: A depth guard instead of a call budget

Research for FORG-49, following [R3, runtime cost](../r3-runtime-cost/README.md) (FORG-42) and
[R4, deployed](../r4-deployed/README.md) (FORG-38). FORG-42's `per-entry-point-shared` strategy counted
every cross-script call of a request and refused the 30th, to stay under what Cloudflare documents as
"32 Worker invocations" per request. Because of that budget, queue consumers, crons and workflow start
and signal routes kept the in-process engine.

FORG-38 measured the limit deployed on Workers Paid (section 5 of its README, `results/rpc.json`). The
limit is **nesting depth**, not calls:

- 30 nested hops below the probe (32 Workers stages) worked. The 31st threw "Subrequest depth limit
  exceeded", for RPC and fetch alike.
- 1,000 sequential calls to a service binding passed in one request.
- 5,000 callbacks into an `RpcTarget` stub passed.
- A 40-deep ping-pong through callbacks passed, because a callback runs in the stage of the Worker that
  owns the stub.

This change replaces the budget with a depth guard and shares those four entry points again. The branch
is off main `6b30f4d`. **Every number below is local** (Miniflare / workerd, or bundle sizes). Nothing
was deployed. Local workerd does not enforce Cloudflare's depth limit, so the limit itself is FORG-38's
deployed measurement.

## Reproduce

```sh
pnpm install --frozen-lockfile && pnpm -r run build
bash research/composable-units/r4-depth-guard/run.sh
pnpm --filter @forgegraph/linker-packed exec vitest run test/shared.test.ts
```

`run.sh` builds forgec, the runtime and acme's units. It then writes three files:

- `results/measure.json`: sizes, deploy bytes and the one-body-edit re-upload, measured as FORG-42 did.
- `results/conformance.json`: the linker-A differential, run with `T3_DIFFERENTIAL=1` and
  `LINK_RESULTS` set to this directory.
- `results/trace.json`: the depth and calls of every shared request over the suite.

`results/before.json` comes from the same `measure.ts`, run on the unchanged tree at `6b30f4d` before
any edit.

The machine was macOS arm64, Node 24.14.0, esbuild 0.27.7, with miniflare 5.20260918.0-alpha
(workerd 1.20260918.1). The compatibility date is 2026-09-01. Bundling is FORG-29/37/42's.

## The guard

Code: `DepthGuard` in `packages/linker-packed/src/shared/script.ts`.

**Stages.** The router is stage 1, so a script it calls is stage 2. A queue batch or a cron is
started by the platform, so it is stage 1. Every call a script makes starts the stage after its own.

**Limit.** The call that would start **stage 30** is refused, which leaves 3 stages in hand, as FORG-42's
budget left 3 calls. Workers refuses the 33rd stage. The limit is `MAX_DEPTH = 29`, configurable per
link with `LinkOptions.maxDepth` or `forge-link-packed --max-depth <n>`. It must be an integer from 3 to
32, because a shared request needs stages 1 to 3.

**Unlimited.** Sequential calls, callbacks and unit `deps` calls have no limit. They are still counted
in `calls`, but only for the research trace.

**How depth propagates** across each hop the strategy creates:

| hop | how the depth crosses it |
| --- | --- |
| router → script (fetch) | The router stamps `x-forge-depth: 2`, overwriting any value a client sent. Only the shared strategy's router does this, so `per-entry-point`'s router is byte-identical. |
| script → runtime Worker (RPC) | The script checks `own stage + 1` before calling. |
| runtime → script (callbacks on `Capabilities`) | A callback runs in the stub owner's stage, the script's own (FORG-38's ping-pong). The stub holds the request's `DepthGuard`, so a call made from inside a callback is checked at `script stage + 1`, however the runtime reached it. The runtime Worker has no bindings, so it can start no stage except through the stub. |
| unit `deps` → engine | These are callbacks on the runtime's stub, so they run at the runtime's stage. No new stage starts. |
| script → dispatch owner, script → Durable Object (fetch) | The script checks `own stage + 1` and stamps it in `x-forge-depth`. |

The incoming header is parsed as an integer of at least 1. Anything else (absent, `0`, negative,
fractional, junk) counts as stage 1. A client can only make its own request refuse earlier. Lowering
the value would only reach the platform's own limit, and the router overwrites the value anyway. The
script strips the header before the engine sees the request.

**The error is unchanged.** A refused request still answers **500 `RpcBudgetExceeded`**, retryable
false, with the same `type` URL and title, and the runtime's own answer is discarded. A queue batch
still throws, so its messages retry. Only the `detail` text changed: it now names the script's stage,
the stage the refused call would start, the limit, and whether a write had committed. The class is
`DepthExceeded`, and its `name` is still `RpcBudgetExceeded`.

**One consequence.** Every hop the strategy makes from a script is `script stage + 1`, the same stage
as the runtime call that is checked first. So once a request reaches the runtime, nothing inside it is
refused. In practice the guard refuses at the script's entry. The check inside the runtime stays as
defence in depth.

**Other change.** With no budget there is nothing to reserve, so every committed tenant gets its
post-commit hand-off. FORG-42 forwarded only the first and left the rest to the cron sweep.

## Results

### Which groups stay in process

The groups `inProcessReason` keeps in process (`shared/link.ts`):

| | before (`6b30f4d`) | after |
| --- | --- | --- |
| workflow class, realtime object, websocket upgrade, dispatch owner | in process | in process (unchanged: they cannot leave their isolate) |
| cron `NightlyReconciliation` | in process | **shared** |
| queue consumer `fulfill-order` | in process | **shared** |
| `POST /v1/orders/{order}/process` (workflow start) | in process | **shared** |
| `POST /v1/workflows/process-order/signals/{message}` (signal) | in process | **shared** |
| scripts carrying the engine | 8 | **4** |

### Bytes (local bundle sizes)

From `results/before.json` and `results/measure.json`. Per-script figures are min / median / max over
the 87 group scripts. Deploy totals include the router and the runtime Worker.

| `per-entry-point-shared` | raw per script | gzip per script | deploy raw | deploy gzip | in-process scripts' raw |
| --- | --- | --- | --- | --- | --- |
| before | 12,010 / 50,848 / 333,568 | 4,482 / 8,102 / 95,926 | 7,422,587 | 1,515,468 | 2,417,912 (8) |
| **after** | 12,538 / 51,376 / 333,568 | 4,699 / 8,309 / 95,926 | **6,856,861** | **1,349,562** | 1,216,972 (4) |
| change | +528 / +528 / 0 | +217 / +207 / 0 | **−565,726 (−7.6%)** | **−165,906 (−10.9%)** | |

For reference, on the same tree `per-entry-point` deploys 26,006,029 B (7,419,587 B gzip) and `single`
deploys 543,002 B (116,442 B gzip). The runtime Worker is unchanged at 306,202 B (97,672 B gzip).

| script that moved | before, in process (raw / gzip) | after, shared (raw / gzip) |
| --- | --- | --- |
| cron `NightlyReconciliation` | 290,573 / 84,864 | 142,570 / 39,989 |
| queue consumer `fulfill-order` | 286,753 / 82,855 | 144,105 / 40,051 |
| workflow start `…/process` | 311,781 / 89,223 | 153,311 / 41,848 |
| workflow signal `…/signals/{message}` | 311,833 / 89,241 | 153,377 / 41,866 |
| **total** | **1,200,940** | **593,363** (−607,577) |

**Where the bytes went.**

- Moving the four scripts saves **607,577 B** raw.
- The guard costs **528 B** raw (about 210 B gzip) in each of the 79 scripts that were already shared,
  about 42 KB in all, plus 87 B in the router.
- The net is **−565,726 B**.

FORG-38 estimated 0.77 MB, which is the difference between two of R3's runs (6,643,972 B against
7,417,292 B). Measured here, the four moved scripts still hold about 140 KB each, because their js
units import Effect themselves. Taking that out needs a units API change, as R3 said.

**A one-body edit** (`impl/rebuild-order-summary.ts`, as FORG-29/37/42) re-uploads the same 6 of 89
scripts. Three of them are the cron and the start and signal routes, which are now smaller:

| | re-uploaded raw | re-uploaded gzip |
| --- | --- | --- |
| before | 1,701,727 | 488,341 |
| **after** | **1,237,352 (−27%)** | **348,917 (−29%)** |
| `per-entry-point`, for reference | 1,850,263 | 533,416 |

### Correctness: the linker-A differential (local workerd)

`results/conformance.json`: `T3_DIFFERENTIAL=1`, `LINK_RESULTS` set here. All 15 scenarios (221 steps)
plus the realtime WebSocket check ran on each target, one Miniflare instance per target.

| target | scripts | scenarios | realtime | unexplained differences from whole-app |
| --- | --- | --- | --- | --- |
| whole-app | 1 | 15 / 15 | pass | n/a |
| whole-app again (A/A) | 1 | 15 / 15 | pass | 0 (100 run-to-run positions) |
| `single` | 1 | 15 / 15 | pass | **0** |
| `per-entry-point` | 88 | 15 / 15 | pass | **0** |
| `per-entry-point-full` | 88 | 15 / 15 | pass | **0** |
| **`per-entry-point-shared`** | **89** | **15 / 15** | **pass** | **0** |

### Depth and calls over the suite (local workerd)

`results/trace.json` covers 247 shared invocations over the 15 scenarios, with 0 refused and 0
scenarios failed:

| | count | stage the script ran at | deepest stage started | cross-script calls (min / median / p95 / max) |
| --- | --- | --- | --- | --- |
| HTTP requests | 240 | 2 | 3 | 1 / 4 / 13 / **40** |
| queue batches | 7 | 1 | 2 | 8 / 8 / 9 / 9 |
| crons | 0 | | | |

- **The deepest stage any shared request starts is 3**, against a limit of 29 and the platform's 32.
  That is the runtime Worker, a dispatch hand-off or a Durable Object, all one stage below a routed
  script. As FORG-38 noted, the strategy's depth is fixed by its shape.
- **Two requests made 30 and 40 calls.** Both are `POST /v1/orders/{id}/process`, the workflow start
  route, which advances the instance inline. FORG-42's budget would have refused both. That is why it
  kept the route in process. Now both pass, at stage 3.
- **The suite fires no platform cron.** The schedules scenario ticks a route instead, so the shared cron
  path is covered by `test/shared.test.ts`, with 1,000 callbacks from a cron.

## Tests

In `packages/linker-packed/test/shared.test.ts`, FORG-42's three budget tests were replaced:

- The default refuses at stage 30 (`MAX_DEPTH` is 29).
- Callbacks are unlimited: 5,000 D1 callbacks in one request answer 200.
- Sequential calls are unlimited:
  - 1,000 Durable Object fetches from callbacks are all stamped stage 3, never deeper;
  - 1,000 unit `deps` calls succeed;
  - every committed tenant gets its hand-off, stamped stage 3.
- A queue batch and a cron run at stage 1 and make 1,000 callbacks each.
- A real script → runtime → script chain, nesting through Durable Object fetches:
  - scripts at stages 2–28 reach the runtime (27 serves, stamps 3–29);
  - the script at stage 29 is refused before its runtime call;
  - the answer is 500 `RpcBudgetExceeded` with "would start stage 30", and nothing written;
  - the engine never sees the header.
- The limit is configurable: with `maxDepth: 10`, the chain stops at stage 10.
- A request arriving at stage 29 or 40 never reaches the runtime, and junk header values count as
  stage 1.
- The link:
  - only the four platform-bound groups stay in process, and the cron, the queue consumer and the start
    and signal routes are shared;
  - the shared router stamps the header and `per-entry-point`'s router does not;
  - `maxDepth` is emitted into every shared script, and 2, 33 and 4.5 are rejected.

## Limits of this evidence

- The limit rests on FORG-38's one Worker, one account and one date (2026-10-25). The docs still say "a
  maximum of 32 Worker invocations". The guard keeps 3 stages in hand, and the limit is a link option if
  the platform changes.
- The **subrequest** limit still applies to each service-binding call (Paid: 10,000 by default). Nothing
  here limits calls. The suite's maximum is 40, and FORG-38 passed 5,000 callbacks deployed.
- The in-process hosts (the dispatch owner, the realtime object, the workflow class) receive
  `x-forge-depth` but do not guard their own calls. Those calls are `host.ts`'s and are unchanged: at
  most one service-binding hop, to the dispatch owner, which itself makes none.
- Cold start and latency deployed were not re-measured. The guard adds no call: its only additions are
  a header and a counter.
