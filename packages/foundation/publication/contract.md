# publication contract

Phase 0 design contract for [issue #48](https://github.com/gmackie/forgec/issues/48), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F48-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/publication`. Hard package dependencies: `decision`, `specification`, `artifact`, `evaluation`, `evidence`, `participation`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- ReleaseCandidate.
- Release.
- PublicationChannel.
- Promotion.
- ReleaseAudienceLink.

Commands:

- Register candidate.
- Attach qualification.
- Publish release.
- Promote release.
- Deprecate release.
- Retire release.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain model, firmware, curriculum, recipe and software release details reference ReleaseCandidate or Release. Audience uses typed participation identities. Deployment wrapper joins releases to Change/Reconciliation above core.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Candidate is proposed, qualifying, qualified or rejected. Release is published, deprecated or retired; transitions add history without editing content pins. Qualification policy specifies when Evaluation and Decision are required. Promotion checks the selected policy atomically.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Release retains exact specification and artifact pins.
- Channel is mutable discovery and release is immutable history.
- Promotion creates a durable fact under qualification policy.
- Publication does not assert deployment or realization.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F48-01` (compile, planned): candidate/release model.
- `F48-02` (compile, planned): exact spec/artifact pins.
- `F48-03` (compile, planned): channel/audience model.
- `F48-04` (runtime, planned): promotion history.
- `F48-05` (compile, planned): qualification/evaluation/decision hooks.
- `F48-06` (runtime, planned): deprecation/retirement lifecycle.
- `F48-07` (fixture, planned): fixtures for software release, model release and controlled recipe/document publication.
- `F48-R01` (concurrency, planned): Concurrent promotions preserve a consistent channel and promotion history.
- `F48-R02` (runtime, planned): Failed selected qualification gate blocks publication.
- `F48-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F48-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- software release: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- model release: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- controlled recipe publication: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- controlled document publication: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
