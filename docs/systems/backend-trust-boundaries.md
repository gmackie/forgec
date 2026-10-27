# Forge Systems: executable backend trust boundaries

**2026-10-27 • PR #242 • Status: local implementation, provider releases unverified**

## Authorities and data flow

1. Domain clients authenticate with the existing host (OAuth/OIDC/Better Auth,
   Cloudflare Access or an equivalent trusted issuer). The host—not an MCP
   argument, HTTP body, or user-selectable `tenant` field—establishes actor,
   tenant, scopes, current membership and action purpose.
2. SystemGateway accepts only installed, reviewed operation bindings whose
   catalog owner and purpose match the signed Foundation package/adapter.
   Closed schemas and trusted decoders validate user input. Gatekeeper checks
   the resource and operation independently of any recorded business approval.
3. Decision, Change, Reconciliation, Agreement and other Foundation services
   remain authoritative. The Action Center and cross-system inspectors are
   policy-filtered projections; they never mutate the original business facts.
4. Action requests atomically reserve a SQLite command intent before remote
   I/O. The backend idempotency key is independent of agent-controlled retry
   keys. The provider must itself implement the exact idempotency and
   revision/precondition check. A success receipt only means `acknowledged`.
5. HMAC producers are pinned to an explicit service and tenant; timestamp,
   raw bytes and event ID are verified before ingestion. Production provider
   webhooks must use their own documented signing scheme or an authenticated
   bridge that re-signs the canonical Forge producer event.
6. Missing source events or unverified provider observations block derived
   actions and readiness. Full source snapshots resynchronize fenced gaps.
7. A reserved but unclaimed command can be resumed by an explicitly authorized
   operator after current source and represented actor policy are checked.
   A claimed/in-progress/uncertain command is **never** redispatched on timer;
   recovery checks the original provider key and retains `uncertain` on absence.

## Atomicity and provider limits

The Node SQLite adapter uses one `BEGIN IMMEDIATE` transaction for event
inbox updates, dedup and command state transitions. It is an executable local
profile and cannot be treated as proof of D1, PostgreSQL, Cloudflare Durable
Object or DynamoDB semantics. The real provider must preserve natural-key
idempotency, single-winner dispatch claims, event gap fencing and atomic
receipt+projection state after crashes/concurrency. The backend cannot provide
exactly-once effects across independent applications and remote providers.

## Secure negative tests (local)

- Actor/tenant/purpose mismatch and unauthorized tool discovery
- Producer signature tampering, stale timestamps, wrong tenant, event collision
- PR/source revision amendment, plan digest amendment, mismatched CI evidence
- Missing/ambiguous symbols, absent verified deployment observation
- Duplicate and competing command attempts with different client keys
- Crash-after-reservation versus crash-after-provider-dispatch
- Unknown provider outcome, stale external state and no unauthorized redispatch
- Fulfillment lacking acceptance, acceptance lacking exact evidence,
  settlement unsupported by fulfillment
- Remediation reported complete without subsequent verified observed convergence

## Remaining release gates

Production integration needs real KanBanger/ForgeGraph source/evidence adapters,
Loom stable source anchor and PR revision mapping, exact Approval/Decision
bindings, Gatekeeper PIPs and genuine hosted-provider assertions. Add a
separately migration-tested D1/DO or PostgreSQL ledger and an authenticated
cross-service recovery worker. Implement a non-SDLC pilot with actual upstream
systems and external-effect verification; synthetic fixtures are not sufficient
for acceptance. All ten catalog entries remain open until their individual
end-to-end acceptance issues (#244–#253) are complete.

## Revision-aware source and configuration references

WorkGraph owns the immutable original anchor and its association with work;
Loom/SCM owns exact snapshot bytes and semantic lookup, and ForgeGraph owns
changeset and deployed-resource evidence. `SourceReferenceResolver` queries
those trusted systems without creating a competing source-of-truth graph.
Path-level source permission is checked independently of backlog visibility;
semantic relocations remain advisory and never override immutable originals.
A matching name/line number is not sufficient proof of code/resource identity.
Real application adoption needs mapping to current KanBanger `trace_links` and
`issue_git_links`, eventual Loom P1 symbol indexes and IaC provider identities.
