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
