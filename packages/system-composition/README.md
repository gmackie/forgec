# Forge composed systems (experimental, non-deploying)

This package is a first executable assembly layer over the existing 74 Foundation
packages. A **system** is an installable, domain-neutral *composition contract*,
not another universal Task, EntityRef, Decision, or case database. Existing
Foundation packages remain authoritative for their facts.

Included in this slice:

1. `catalog/systems.json`: ten candidate system compositions and explicitly
   typed capability/port ownership, purposes and invariants.
2. `src/index.mjs`: deterministic, dependency-ordered closure planning from real
   `packages/foundation/*/contract.json` files, with fail-closed graph checks.
3. `src/action-center.mjs`: a projection of pending external actions that
   enforces tenant/assignee filtering, a host-supplied read/command authorization
   boundary, version-gap fencing, trusted producer IDs and authoritative
   dispatch. Command submission never auto-completes a task or approval.
4. `src/change-intelligence.mjs`: an advisory, exact source/plan revision-bound
   change/evidence projection. It cannot approve a PR or deploy anything.

## Check the live source catalog

```sh
node packages/system-composition/scripts/check-catalog.mjs
node packages/system-composition/scripts/check-catalog.mjs --json
node --test packages/system-composition/test/*.test.mjs
```

The catalog planner is **read-only**. It does not generate a `forge.lock`, bind
live services, run `forgec`, migrate a database, produce signed provider evidence,
or create an MCP server. A locally passing Foundation acceptance entry does not
establish production or hosted-provider readiness; every plan explicitly reports
unverified hosted/application integration.

## Exercise the cross-system composition fixture

```sh
node packages/system-composition/examples/change-lifecycle.mjs
```

This checks a synthetic policy-review workflow from Action Center invitation to
actual decision, deploy acknowledgement, and reconciliation observation. It
proves the boundary contract under fixture inputs, **not** real deployment.

## Scaffold a concrete Forge package

```sh
node packages/system-composition/scripts/scaffold-system.mjs change-intelligence examples/my-change-system
cd examples/my-change-system
forgec lock . && forgec check . && forgec build .
```

The scaffold creates the `.forge` imports and explicit `deploy = true`
dependencies for the selected roots, but intentionally omits business records,
handlers, approvals, and policies. It will refuse to overwrite a directory.
Compiler compatibility is not claimed until the generated output has actually
passed `forgec` on the target revision.

## Expected production wiring

- KanBanger/WorkGraph owns SDLC task and work/document facts.
- The independent approvals system owns actual approval decisions.
- ForgeGraph owns delivery facts; Loom or SCM owns source revisions.
- Gatekeeper and authoritative providers check permissions again on all reads
  and mutations. The Action Center's projection has no independent authority.
- Consumers should use durable event inbox/outbox, trusted producer credentials,
  idempotency receipts, version-fenced dispatch and fresh source reconciliation.
  This experimental in-memory projection is **not** that durable deployment.

This package intentionally does not change the `.forge` DSL, canonical Foundation
schemas, provider storage adapters or production deployment. Those require
separately verified compiler/runtime migrations and staged rollout. See
`docs/systems/composition-roadmap.md` for the integration acceptance matrix.

## Second slice: durable Node backend and authorized API/MCP entrypoints

The original `ActionCenter` is an ephemeral in-process projection retained for
compatibility tests. **`DurableActionCenter` + `SqliteActionLedger`** is the
local/Node durable implementation. It enforces transactional receipt deduplication,
revision gap fencing, immutable command terms, logical-op deduplication and a
persistent backend idempotency key. Ambiguous remote outcomes remain `uncertain`;
retry never dispatches them again. An operator may safely resume an unclaimed
`reserved` intent after *fresh* source and policy checks. A claimed, uncertain
operation must instead be reconciled against the authoritative provider.

Example application wiring (the host supplies authenticated principal and
purpose-bound capabilities):

```js
import {SqliteActionLedger} from './src/sqlite-ledger.mjs';
import {DurableActionCenter} from './src/durable-action-center.mjs';
import {createSystemHttpHandler,createMcpHttpHandler} from './src/http.mjs';

const ledger = new SqliteActionLedger({filename:'./actions.sqlite'});
const actions = new DurableActionCenter({
  ledger,
  producers: {approvals: {
    kinds:['approval'],
    purposes: {decide:'approvals.decide'},
  }},
  authorize: trustedPolicyCheck,
  dispatch: trustedApprovalProvider,
  reconcile: trustedApprovalStatusLookup,
});
const handleApi = createSystemHttpHandler({
  gateway, actionCenter:actions, authenticate:trustedOAuthMiddleware,
  verifyProducer:trustedProducerSignatureVerification,
});
const handleMcp = createMcpHttpHandler({
  gateway, authenticate:trustedOAuthMiddleware,
  canDiscover:trustedToolDiscoveryPolicy,
});
```

This example documents host-injected ports, **not** runnable globals. Never
replace the trusted functions with unverified request fields. Installable
`SystemGateway` operations use the catalog's immutable owner and purpose, a
closed input JSON Schema and a trusted application decoder/projector. Commands
require a durable ledger, logical subject key, business revision and
idempotency key. MCP descriptors come from these exact bindings; REST and MCP
invoke one gateway and must not gain alternate database or authorization paths.

The HTTP handler supports a deliberately small MCP 2026-07-28 JSON-RPC subset;
full interoperability, capabilities beyond tools, TLS/issuer deployment, origin
configuration and transport tests against third-party MCP clients remain
deployment acceptance requirements. Production should prefer the repository's
existing `@forgegraph/interfaces/mcp` runtime projection where its feature
profile suffices. Do not claim the small HTTP adapter is an independently
certified general MCP server.

The `createKanbangerReader` adapter calls the **actual** Effect API paths
`/api/workspaces/:workspaceId/issues/:issueId`,
`/api/workspaces/:workspaceId/issues/:issueId/delivery` and
`/api/workspaces/:workspaceId/delivery/needs-me` using an actor-scoped
credential furnished by the host. Each read rechecks policy and suppresses
arbitrary delivery payloads. It does not promote KanBanger's reported PR,
check or deploy states to ForgeGraph authoritative evidence. A real ForgeGraph
read adapter and original-source/plan revision corroboration are still needed
for change completion.

`ChangeControlCollector`, `CommitmentInspector` and `ExceptionInspector` are
read-only cross-provider projections. They reject inconsistent tenants,
revisions, unverified evidence or mid-read source changes. In particular:

- a reported PR merge is not verified production deployment;
- a completed task is not contractual acceptance;
- a provider command receipt is not proven fulfillment or payment;
- an uncertain remediation may only be cleared after authoritative observation;
- Gatekeeper authorization and recorded human approval are different facts.

### Running the local tests

```sh
node --test packages/system-composition/test/*.test.mjs
node packages/system-composition/scripts/check-catalog.mjs
```

The second command intentionally requires the full Forge source checkout.
The Forgejo `systems` CI job executes it against real Foundation contracts
and is included in the central deploy-status report. The isolated Node tests
exercise a real SQLite file, restart/recovery, HMAC-signed producer ingress,
unauthorized user/tenant paths, and a real loopback HTTP request.

### Provider and production gaps

- Node SQLite is a **local/Node profile**. Do not deploy `node:sqlite` into a
  Cloudflare Worker. A separately implemented Durable Object/D1 or hosted SQL
  adapter must prove atomic projection writes, intent CAS, migrations and
  provider-specific concurrency under real workloads.
- Cross-system provider requests are outside SQLite transactions. An
  `acknowledged` state means only that the downstream provider accepted the
  dispatch; it is never a business decision or a verification of effects.
- Real KanBanger/ForgeGraph/Loom/Approvals/Gatekeeper deployments, credential
  exchange, signoff semantics and backward-compatible migrations are not
  configured by this library and require staging verification.
- No background process, scheduled worker, production webhook credential or
  remote side effect is created by importing this package.

`SourceReferenceResolver` implements a read-only, revision-aware resolution
boundary for WorkGraph-owned immutable code/IaC anchors. It checks both task
and path-level source authorization; exact historical snapshot identity
remains available, while relocations require a matching semantic ID or byte
hash. Ambiguous, missing and deleted/replaced locations are explicit, never
silently guessed. Loom's P1 semantic index is still required for production
resolver precision; the test fixture is not that implementation.

## ForgeGraph read-only integration

`createForgeGraphReader` calls the real `/api/fg/changesets/:id` and `/api/fg/evidence?changesetId=:id` APIs with an actor-scoped host credential. It requires a second host-validated repository-scope check because the current ForgeGraph bearer changeset GET does not enforce workspace membership itself. Results are allowlisted and marked `deploymentVerified: false`: a merged changeset, passing build and successful test do not prove production deployment. Some evidence routes require a session rather than a bearer; no credential escalation is attempted.
