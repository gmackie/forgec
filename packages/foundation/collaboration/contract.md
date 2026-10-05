# collaboration contract

Phase 0 design contract for [issue #49](https://github.com/gmackie/forgec/issues/49), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F49-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/collaboration`. Hard package dependencies: `participation`, `artifact`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Thread.
- ThreadEntry.
- Reaction.
- Mention.
- ThreadParticipant.
- AttachmentLink.

Commands:

- Open thread.
- Append entry.
- React.
- Mention participant.
- Attach artifact.
- Close thread.
- Rebuild activity projection.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Discussable facet adds optional typed Thread sidecar to each application resource. Domain-specific entry detail uses typed satellites. Content is Artifact-backed or typed entry content; no universal JSON payload.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Thread is open or closed; reopening is an explicit permissioned operation. Entries preserve author/time and correction history. Reaction uniqueness is defined per entry/participant/reaction code. Removal/redaction follows governance policy and must not imply immutable audit history can disappear.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Application resource points to Thread; Thread never polymorphically targets application resources.
- Mentions and participants use typed participation identity.
- Attachments use pinned artifact/content references.
- Activity is derived and reconstructible.
- Notifications are composed outside collaboration core.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F49-01` (compile, planned): Thread/Entry/Reaction model.
- `F49-02` (compile, planned): participation/mention integration.
- `F49-03` (compile, planned): attachment/artifact integration.
- `F49-04` (compile, planned): Discussable-style sidecar facet.
- `F49-05` (runtime, planned): activity projection.
- `F49-06` (fixture, planned): fixtures for KanBanger issue, ForgeGraph deployment and LevelForge candidate.
- `F49-R01` (concurrency, planned): Concurrent identical reactions obey uniqueness policy.
- `F49-R02` (runtime, planned): Unauthorized mention or attachment reference is rejected.
- `F49-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F49-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- KanBanger issue: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- ForgeGraph deployment: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- LevelForge candidate: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.

## Implemented local profile

The executable package and generated consumer now have local memory, SQLite and PostgreSQL evidence in `packages/runtime/test/foundation-collaboration.test.ts`. See `README.md` for the implemented protocol and explicit limits; `contract.json` records per-case status. Earlier design prose above is the target boundary, not a claim of broader guarantees. Hosted provider certification and real-application dogfooding remain separate.
