# change contract

Phase 0 design contract for [issue #41](https://github.com/gmackie/forgec/issues/41), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F41-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/change`. Hard package dependencies: `decision`, `specification`, `evaluation`, `fulfillment`, `evidence`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Change.
- ChangeImpactLink.
- ChangeDecisionLink.
- ChangeImplementationLink.
- ChangeVerificationLink.
- ChangeSupersession.

Commands:

- Propose change.
- Attach impact assessment.
- Attach decision.
- Schedule implementation.
- Record fulfillment.
- Verify change.
- Record rollback.
- Supersede change.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Application deployment, recipe or policy change resources point to Change. A higher typed bridge composes Reconciliation; core Change does not import it. Domain implementation details reference Fulfillment.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Proposed → assessing → approved → scheduled → implementing → verifying → completed; failed, rolledBack, rejected and cancelled are explicit alternatives. This is a configurable policy, not a mandatory universal state sequence: simplified ungated lifecycles are supported. Completion requires verification only if the selected policy requires it.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- From and to refer to exact immutable specification pins.
- Selected gate policy is fixed before execution.
- Rejected approval blocks gated implementation.
- Rollback and supersession create explicit history rather than editing original pins.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F41-01` (compile, planned): exact from/to specification pins.
- `F41-02` (compile, planned): impact evaluation linkage.
- `F41-03` (compile, planned): decision linkage.
- `F41-04` (compile, planned): implementation fulfillment linkage.
- `F41-05` (compile, planned): verification/evidence linkage.
- `F41-06` (compile, planned): rollback/supersession semantics.
- `F41-07` (fixture, planned): fixtures for software deployment, recipe change and policy change.
- `F41-R01` (concurrency, planned): Concurrent approval/implementation cannot bypass selected gate.
- `F41-R02` (runtime, planned): Gated completion rejects missing verification while ungated policy permits it.
- `F41-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F41-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- software deployment: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- recipe change: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- policy change: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- simplified ungated change: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
