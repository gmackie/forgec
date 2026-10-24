# @forgegraph/linker-tiered

**Stability: internal (research, FORG-43).** Not published.

Linker C (tiered). Packed scripts from linker A (`@forgegraph/linker-packed`) by default, and linker B's
dynamic host (`@forgegraph/linker-dynamic`) for the closures a link-time policy marks dynamic. A
dynamic miss falls back to the packed script for that entry point; the fallback is logged, counted and
named in a response header.

```sh
pnpm --filter @acme/commerce-deploy units:build          # forgec build --units + seal
pnpm --filter @forgegraph/linker-dynamic build           # linker B's shared libraries
node packages/linker-tiered/src/cli.ts examples/acme     # --policy defaults to deploy/cloudflare/tiered-policy.json
```

Output goes to `<app>/generated/linked/tiered/`:

| path | what |
| --- | --- |
| `packed/` | linker A's `per-entry-point` link of **every** entry point, dynamic ones included: a dynamic entry point's packed script is its fallback. Linked with A's `advance` option, so the script holding a workflow class also serves one driver step over its service binding. |
| `<pkg>-tiered/` | the tiered router (replaces A's router, which is linked but not deployed). |
| `<pkg>-dynamic/` | the tier host: B's host plus the Workflows class of every dynamic workflow. |
| `tiered.json` | the deployment: policy, dynamic entry points and their packed fallbacks, script hashes, `deploy` (the scripts to upload). |
| `packed/<script>/wrangler.tiered.jsonc` | A's config for the packed scripts that name a dynamic workflow, rebound to the tier host's class. |

## Marking closures dynamic

A **link-time policy**, not a manifest field (`src/policy.ts`, `examples/acme/deploy/cloudflare/tiered-policy.json`):

```json
{ "version": "tiered-policy/1", "dynamic": { "entryPoints": ["POST /v1/orders", "POST /v1/orders/**", "@acme/commerce/_/ProcessOrder"], "closureHashes": [] } }
```

- `entryPoints` are entry point ids or globs over them (`*` within a path segment, `**` across).
  `closureHashes` select every entry point whose closure hashed to one of them **at link time**.
- The policy resolves to a list of entry point ids. The manifest, its `manifestHash`, every
  `closureHash` and the packed scripts are the same whatever the policy says, so tiering never changes
  manifest identity, and the same sealed manifest feeds A, B and C.
- A dynamic swap changes a dynamic entry point's closure hash; the entry point stays dynamic, because
  the router holds ids. A hash in the policy therefore pins "the entry points that had this closure
  when we linked", which is what a tenant extension or a preview wants to name.
- A workflow's steps share its tier (they run inside its driver step). A step cannot be named on its
  own, and a closure hash selects a step only through its workflow (acme's `ProcessOrder#submit` has
  the submit route's closure).
- Refused at link time: a selector that matches nothing; a cron (including `forge:sweep`), a queue
  consumer, a Durable Object or an in-process subscription (the platform invokes these on the script
  that declares them, which is packed); a realtime upgrade route (B links no realtime object); a route
  with no closure (nothing to load).

Moving an entry point between tiers is a re-link of the router and the tier host. No packed script
changes.

## Request path

The router (`src/link.ts`, `routerSource`) has A's table and order, each row tagged with its entry
point when that entry point is dynamic. An exact (method, path) match on a dynamic row goes to the tier
host first; everything else goes to its packed script, as in A. The body is buffered once so the
fallback can replay it.

**A dynamic miss** is an answer from the tier host carrying `x-forge-linker-refused: <code>`. B sets it
on every refusal it makes *before a request reaches unit code*, and strips it from a child's response:

| code | when |
| --- | --- |
| `NoManifest` | no dynamic manifest linked yet |
| `UnknownEntryPoint` | the dynamic manifest has no such entry point (an entry point can be withdrawn from the dynamic tier by a manifest swap) |
| `LoaderUnavailable` | no Worker Loader binding, or `LOADER.get` throws |
| `LoadFailed` | the child does not start: the tier host probes each child (`Forge.ping`) before forwarding |
| `MissingModule`, `ModuleDigestMismatch`, `MissingLibrary`, `BuildMismatch` | the child's code cannot be assembled from the unit store |

On a miss the router replays the request to the packed script, sets `x-forge-tier: packed-fallback`
and `x-forge-tier-miss: <code>`, logs `linker-tiered: FALLBACK <entry> -> packed (<code>)` and counts
it (`GET /_forge/tiered/stats` with `x-forge-tier-token`, per router isolate: `dynamic`, `packed`,
`fallback`, `errors`, `byReason`, `byEntryPoint`, the last 50). Every other answer says
`x-forge-tier: dynamic` or `packed`.

Not a miss: a 403 `CapabilityDenied` from a child (a policy answer, and falling back would hand the
request to a script with other capabilities), any 4xx or 5xx the runtime answers, and an exception
from the tier host. An exception after the probe may come after unit code ran, so replaying it is not
safe: the router answers 502 `DynamicTierFailed` and counts an error. The rule is **fall back only when
the dynamic tier proves nothing ran**.

A dynamic workflow's class lives in the tier host (`src/host.ts`, `tier().workflow`). Each driver step
runs in B's child (`advanceWorkflow`); a `LinkError` (the same set of misses) replays that step on the
packed script holding the workflow, through A's `POST /_forge/linker/advance`, logs it and counts it
(`GET /_linker/tier` on the tier host, admin token). Steps are durable (`step.do`), so a step falls back
or not as a whole.

## Updating the dynamic tier

The tier host keeps B's `/_linker/*` administration: `PUT /_linker/blobs` for new module bytes and
`PUT /_linker/manifest` for the new manifest. That is the whole deploy for an implementation change in
a dynamic closure: no script in the tiered link is uploaded. The tier host refuses (409
`TierBindingMissing`) a manifest whose dynamic entry points need a binding it was not deployed with,
because B's child would get no handle and the runtime would quietly do without (a memory object store,
the cron as workflow timer). New bindings, and new or re-tiered entry points, are a re-link.

Packed scripts keep the implementation they were linked with. After a swap, a fallback serves the
packed (older) implementation, and packed entry points whose closure holds the edited unit (acme's
`forge:sweep`) run the old one until the next full link. The header says which tier answered.

## One dispatch owner

Linker A's sweep script (`forge:sweep`'s group, `dispatchOwner`) is the only script that sweeps the
outbox, runs crons and records tenants in the schedule index, for both tiers:

- packed scripts forward their post-commit nudge and first-sight tenants to it (`FORGE_DISPATCH`), as in A;
- the tier host binds `FORGE_DISPATCH` to the same script, and B, seeing it, sends the same
  `{ tenant, sweep }` there instead of creating its dispatch child;
- B's children never sweep in-process (`postCommit` is a no-op);
- the tier host has no cron trigger and no queue consumer; `forge:sweep` cannot be marked dynamic;
- a request is served by exactly one tier: the router falls back only on a refusal made before the
  child ran, and B schedules dispatch only after the child answered, so one committed write produces
  one nudge.

The owner's dispatcher claims each outbox row with a lease, as in A and B, so a nudge and a cron sweep
racing on the same tenant still deliver a row once. Tested: a dynamic `POST /v1/orders`, whose child
lacks the `CustomerOrderSummary` projection, ends `delivered` to it with `attempts: 1`, and the tier
host made no dispatch child.

## Capability narrowing

Each tier narrows as it does alone. Packed scripts get only their group's bindings, with refusing stubs
for withheld ones (A). Dynamic children get capability stubs derived from the dynamic manifest: a
table-level D1 gate, one gate per declared R2, queue and workflow binding, refusing stubs for the
others, and no network (B). The tier host itself is deployed with only the bindings its dynamic
entry points declare plus the manifest's host vars and secrets (acme: no `BLOBS`, no `REALTIME`).

## Pieces

| file | |
| --- | --- |
| `src/policy.ts` | the policy and its resolution |
| `src/link.ts` | `linkTiered`: A's link, the router, the tier host, `tiered.json` |
| `src/host.ts` | the tier host's runtime part (bundled into the tier host script) |
| `src/local.ts` | Miniflare serving (on A's `serve`), B's host for the differential, seeding the unit store |

Seams in the other two linkers, all additive:

- A: `LinkOptions.advance` and `HostConfig.advance` (the advance endpoint); `LocalScript.miniflare`
  (extra Miniflare options); the `./local` export.
- B: `FORGE_DISPATCH` in the host env (dispatch hand-off and child probe); `REFUSED_HEADER` on refusals;
  `LoaderUnavailable` and `LoadFailed`; `advanceWorkflow` extracted from `forgeWorkflow`; `Forge.ping`
  in the child; the `./host` export.

## Tests

```sh
pnpm --filter @forgegraph/linker-tiered test        # policy + link (Node), then workerd (Miniflare)
TIERED_DIFFERENTIAL=1 pnpm --filter @forgegraph/linker-tiered exec vitest run test/differential.test.ts
```

The differential needs `research/composable-units/r3-linker-tiered/run.sh`'s links first. Results:
`research/composable-units/r3-linker-tiered/`.
