# decision contract

Phase 0 design contract for [issue #39](https://github.com/gmackie/forgec/issues/39), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F39-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/decision`. Hard package dependencies: `participation`, `evidence`, `evaluation`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- DecisionCase.
- DecisionOption.
- DecisionResponse.
- DecisionOutcome.

Commands:

- Open case.
- Add option.
- Invite participant.
- Record response.
- Withdraw response.
- Finalize outcome.
- Expire case.
- Open reconsideration.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain-owned option and response detail resources reference the corresponding DecisionOption or DecisionResponse. Application subjects point to DecisionCase; cases have no universal subject pointer.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Open → collecting → decided, withdrawn or expired. Rule configuration selects one responder, first valid, quorum, unanimous, choose-one or ranking. Each rule defines tie, abstention, eligibility snapshot and deadline behavior before collecting; no arbitrary executable policy language.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Outcome is durable and cannot be silently rewritten.
- Only eligible participants contribute responses under the pinned rule.
- Finalization and deadline expiry compete under one version guard.
- Reconsideration creates a second case linked to the original, preserving both histories.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F39-01` (compile, planned): DecisionCase/Option/Response/Outcome resources.
- `F39-02` (compile, planned): participation integration.
- `F39-03` (runtime, planned): decision-rule abstraction.
- `F39-04` (compile, planned): evidence attachment.
- `F39-05` (runtime, planned): deadline/withdraw/expiry lifecycle.
- `F39-06` (compile, planned): reconsideration linkage.
- `F39-07` (fixture, planned): fixtures for human approval, release gate and review board.
- `F39-R01` (concurrency, planned): Concurrent finalization and expiry produces exactly one terminal outcome.
- `F39-R02` (concurrency, planned): Duplicate logical responses do not increase quorum.
- `F39-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F39-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- human approval: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- release gate: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- review board: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
