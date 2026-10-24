# R3: Linker C, tiered (packed by default, dynamic for marked closures)

Research spike for [FORG-43](https://tasks.gmac.io/gmacko/issue/FORG-43), linker C of the composable-units
design ([composable units on Workers isolates](../../../docs/plans/2026-10-23-composable-units.html)): A
(packed, [T3](../t3-linker-packed/README.md)) by default, B (dynamic, [T4](../t4-linker-dynamic/README.md))
for closures marked dynamic. A dynamic miss falls back to the packed script and is reported as a fallback.
Built over main `479be5c` (FORG-33 coverage, FORG-37 runtime split).

**Everything here ran on local workerd (Miniflare 5.20260918.0-alpha, workerd 1.20260918.1). Nothing
was deployed. Every timing is local client wall time over loopback.**

The linker is `packages/linker-tiered`; its [README](../../../packages/linker-tiered/README.md) is the
design reference (policy, request path, miss rule, dispatch ownership, seams in A and B).

## Reproduce

```sh
pnpm install --frozen-lockfile
bash research/composable-units/r3-linker-tiered/run.sh     # build, link, differential, swap + latency
pnpm --filter @forgegraph/linker-tiered test               # policy, link, workerd tests
```

| file | |
| --- | --- |
| `run.sh` | builds forgec, the runtime, acme's sealed manifest and B's libraries; links the whole-app baseline, A (`per-entry-point`) and C; runs the differential and `measure.ts` |
| `results/conformance.json` | the differential: whole-app, A/A repeat, A, B, C, C with every dynamic request falling back |
| `results/swap.json` | the dynamic swap and the fallbacks |
| `results/latency.json` | local latency, C and A |
| `measure.ts` | writes `swap.json` and `latency.json` |

## Decisions

**Marking closures dynamic: a link-time policy.** `examples/acme/deploy/cloudflare/tiered-policy.json`
lists entry point id patterns (and may list closure hashes). It resolves at link time to entry point
ids; the manifest is untouched, so the same sealed manifest (same `manifestHash`, same closure hashes,
same packed bytes) feeds A, B and C. A manifest field would have made "which tier" part of manifest
identity: moving a preview or a tenant extension between tiers would re-hash the manifest and every
closure that names it. Steps follow their workflow; crons (the sweep included), queue consumers, the
realtime object and in-process subscriptions are refused, because the platform invokes them on the
script that declares them.

Acme's policy, "the write path and the workflow": every order write route, the ProcessOrder workflow
(with its four steps) and its signal route. That is 14 entry points dynamic and 77 packed.

```
POST /v1/orders, POST /v1/orders/**, PATCH /v1/orders/{id}, DELETE /v1/orders/{id},
@acme/commerce/_/ProcessOrder, POST /v1/workflows/process-order/signals/{message}
```

**Shape.** C links A for *every* entry point (each dynamic entry point's packed script is its fallback),
replaces A's router with a tiered router and adds one tier host (B's host plus the Workflows class of
each dynamic workflow). Deploy set: 87 packed scripts, the router and the tier host.

**The miss rule.** Fall back only when the dynamic tier proves that no unit code ran: B marks every
refusal it makes before forwarding to a child with `x-forge-linker-refused` (`NoManifest`,
`UnknownEntryPoint`, `LoaderUnavailable`, `LoadFailed`, `MissingModule`, …). `LoadFailed` needs a
probe: in tier mode B calls `Forge.ping()` on the child before forwarding. Without it, a child that
fails to start throws from the same call that runs the request, and the two cases cannot be told
apart. A 403 `CapabilityDenied`, any runtime answer and any exception after the probe are not misses:
falling back on a denial would hand the request to a script with other capabilities, and replaying
after an exception could run a write twice. The router answers such an exception 502
`DynamicTierFailed` and counts it as an error.

**One dispatch owner.** Linker A's sweep script. Packed scripts forward to it as in A. The tier host
binds `FORGE_DISPATCH` to it, and B then forwards the same `{ tenant, sweep }` there instead of creating
its dispatch child. The tier host has no cron and no queue consumer, and the sweep cannot be dynamic. A
request is served by exactly one tier, because the router falls back only on a pre-execution refusal
and B schedules dispatch only after the child answered. So one committed write sends one nudge, and the
owner's leased claim delivers each outbox row once.

**Workflows.** A dynamic workflow's Workflows class lives in the tier host (its packed script keeps the
class, unused, so its bytes do not move). Each driver step runs in B's child; on a `LinkError` that step
replays on the packed script through A's new `POST /_forge/linker/advance`. The fallback is per step and
durable (`step.do`).

## Results

### Differential: 15/15 everywhere (`results/conformance.json`)

The 15 conformance scenarios, 221 compared steps, each target on a fresh Miniflare instance, compared
with the conformance comparator and classified as in T3: explained, A/A run-to-run noise
(whole-app against itself), or unexplained.

| target | scenarios | unexplained | realtime test | notes |
| --- | --- | --- | --- | --- |
| whole-app | 15/15 | — | pass | today's Worker |
| whole-app-repeat | 15/15 | 0 | pass | A/A control |
| packed (A) | 15/15 | 0 | pass | 87 scripts + router |
| dynamic (B) | 15/15 | 0 | fail (by design) | 53 children, none privileged, no denial; realtime refused `UnlinkedEntryPoint` as in T4 |
| **tiered (C)** | **15/15** | **0** | pass | router: 34 dynamic, 212 packed, **0 fallbacks, 0 errors**; workflow steps: 8 dynamic, 0 fallback; 6 children; **0 dispatch children** |
| **tiered-fallback (C)** | **15/15** | **0** | pass | no dynamic manifest linked: **34/34 dynamic requests fell back** (`NoManifest`), 8/8 workflow steps fell back (`UnknownEntryPoint`), 0 errors |

The second C target is the whole-tier fallback: the tier host is up but holds nothing, so every
dynamic route and every driver step is served by its packed script, and the app still matches the
whole-app Worker step for step.

### Dynamic swap (`results/swap.json`)

The edit is FORG-30's: AuthorizePayment's limit raised from 1000 to 2000 in `impl/payment-adapter.ts`,
re-sealed with the unchanged unit plan.

- **Manifest** `60d3da69…` becomes `36309630…`. Six entry points get new closure hashes: five dynamic
  (`ProcessOrder`, `ProcessOrder#submit`, the process, submit and signal routes) and one packed
  (`forge:sweep`).
- **The dynamic tier's deploy** is one 502-byte module blob plus `PUT /_linker/manifest`: 155 ms
  locally, including the HTTP round trips.
- **Scripts uploaded: 0.** The sha256 of all 90 `worker.js` (router, tier host, 87 packed) is the same
  before and after.
- **Linker A alone** would re-upload 5 scripts (1,554,653 bytes): the sweep, process, submit, signal
  and ProcessOrder scripts.
- **Behaviour.** Before the swap a 1501.00 order submits `409 PaymentDeclined` (dynamic, closure
  `e54a47a4…`). After it the same order is `200 Submitted` (dynamic, closure `3e58e103…`).
  `GET /v1/customers` is still `packed`, 200.
- **Caveat.** The packed `forge:sweep` still holds the old AuthorizePayment until the next full link.
  Its closure contains it (the dispatch unit reaches every workflow), and a workflow sweep that resumes
  a crashed instance runs it. This is the tiered contract (packed is pinned to the deploy), and the
  header shows which tier answered.

### Fallback (`results/swap.json` → `fallback`, and the tests)

| how the dynamic load fails | answer | header |
| --- | --- | --- |
| a manifest whose AuthorizePayment module throws while it is evaluated (the child cannot start) | small order `200 Submitted`; 1501.00 `409 PaymentDeclined` (the packed limit, 1000) | `x-forge-tier: packed-fallback`, `x-forge-tier-miss: LoadFailed` |
| the module blob deleted from the unit store after a host code-cache eviction | `409 PaymentDeclined` (packed) | `MissingModule` |
| no dynamic manifest (tests, and the `tiered-fallback` target) | served packed | `NoManifest` |
| no Worker Loader binding (tests) | served packed | `LoaderUnavailable` |
| a dynamic workflow whose child cannot load (tests) | the instance completes, with steps replayed on the packed script | tier host `workflowAdvances.fallback` |

The router logged each fallback (`linker-tiered: FALLBACK POST /v1/orders/{order}/submit -> packed
(LoadFailed)`, `… (MissingModule)`). It counted them too: `byReason {LoadFailed: 2, MissingModule: 1}`,
`errors: 0`. Re-linking the sealed manifest restored dynamic serving (`200`, `x-forge-tier: dynamic`,
closure `e54a47a4…`).

Not a fallback (test): with `Order#write` dropped from the submit route's imports, submit answers
`403 CapabilityDenied` (`resource:@acme/commerce/_/Order#write`) from the dynamic tier, the order stays
Draft, and the router counts no fallback.

### Local latency (`results/latency.json`; local workerd, n=30, client wall time; noisy)

| request | C (tiered) median / p95 | A (packed) median / p95 |
| --- | --- | --- |
| `GET /v1/customers` (packed in C) | 44.4 / 162.4 ms | 33.6 / 78.3 ms |
| `POST /v1/orders` (dynamic in C) | 33.5 / 100.0 ms | 34.6 / 52.3 ms |
| `POST …/submit` (dynamic in C), warm | 45.9 / 105.3 ms | 25.0 / 63.1 ms |
| `POST …/submit`, first request (cold child) | 91.9 ms | — |
| `POST …/submit`, packed-fallback (`LoadFailed`) | 33.5 / 130.7 ms | — |

These are an order of magnitude above T3's and T4's local readings for the same routes. One Miniflare
instance runs about 90 workers here, on a machine also building the workspace, so the spread is wide and
the medians move by 10 ms between runs. Two things hold across runs: a dynamic write is not cheaper than
packed (each D1 statement is an RPC to the tier host, as in T4), and a fallback costs the refused trip
to the tier host on top of the packed request. A deployed measurement is still open.

## Changes to A and B (exported seams only)

- **A (`packages/linker-packed`).**
  - `LinkOptions.advance` and `HostConfig.advance`: the packed script holding a workflow class serves
    `POST /_forge/linker/advance`, reachable only by service binding. Off by default, so A's own output
    is byte-identical.
  - `LocalScript.miniflare`: extra Miniflare options per script.
  - The `./local` export.
- **B (`packages/linker-dynamic`).**
  - With `FORGE_DISPATCH` bound, B hands dispatch to that owner and probes each child before use.
  - `x-forge-linker-refused` on pre-execution refusals, stripped from child responses.
  - New error codes `LoaderUnavailable` and `LoadFailed`.
  - `advanceWorkflow` exported (extracted from `forgeWorkflow`, which uses it).
  - `Forge.ping()` in the generated child.
  - The `./host` export.
  - Unset `FORGE_DISPATCH` leaves B's behaviour as before.

## Open

- Deployed behaviour: Worker Loader availability on the account, real cold starts, service-binding hop
  cost. All of these readings are local.
- Router counters are per isolate. A deployed router would write to Workers Analytics Engine; the log
  line and the response header are the durable signals here.
- A dynamic queue consumer would need a packed-fallback path for a queue batch (A has none); the policy
  refuses it.
- `forge:sweep` keeps old implementations after a dynamic swap until the next full link (above).
