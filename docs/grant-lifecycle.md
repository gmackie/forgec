# Dependency grant lifecycle (FORGE-066)

A cross-service `uses` edge passes through five distinct states. Each is a separate graph in
`GrantRegistry.graphs()`; none implies the next.

| state | produced by | evidence | access |
|---|---|---|---|
| declared | the caller's IR (`uses { payments.AuthorizePayment }`) | `requestFrom()` → signed `dependency-request/1` | none |
| requested | `ApprovalBot.process()` opens/updates one PR in the callee owner's repository under its `grantsPath` | PR linked to caller commit/head | none |
| approved | independent approvals per required reviewer group on the merged head, into the protected branch | `publishGrant()` → signed immutable `dependency-grant/1` | none |
| activated | `GrantRegistry.admit()` (verified) then `activate()` for the deployed identity after the snapshot carrying the grant is acknowledged | activation record (identity, epoch) | yes: exact caller identity, callee id, purpose |
| observed | runtime edge checks (`guardExternals`) | observed graph | — |

Rules
- A request is not a grant; a merged PR is not a grant; a published grant is not access until activated for *that* identity.
- Grants are non-transitive and purpose-exact: A→B and B→C never authorize A→C; a purpose change on A→B is a new request.
- Security widening (new edge, changed purpose, changed security digest, lowered assurance, changed environment/audience/scope) invalidates review even when semver says "compatible" (`compareRequests`).
- A changed PR head marks every earlier approval stale; publication refuses stale approvals.

Retirement (planned)
1. The caller's new source drops the dependency. Nothing changes at runtime.
2. `observeUse()` records releases/workflows still using the grant.
3. `retire(digest, { drainUntil })` sets `draining` when anything is in use, `retired` otherwise. Within the drain window the edge stays allowed; after it, denied.
4. Shortening a declared drain is a policy decision, not a source change: `retire()` on a draining grant returns the existing window with a note.

Emergency revocation
- `emergencyRevoke(digest, { reason, at, boundMs })` denies immediately, bumps the registry epoch (cached allows die within `boundMs`, the cache lifetime), and writes a tombstone.
- Rollback (re-activating the same grant digest) does not clear a tombstone; a new grant needs a new request and review.

Reporting
- `reviewUnused({ now, sinceMs, telemetryCoverage })` suggests grants with no observed use. It is a suggestion with the telemetry coverage attached; nothing is removed automatically, and absence of observed use under partial coverage is not proof of no use.
