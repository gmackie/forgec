# adjudication contract

Phase 0 design contract for [issue #44](https://github.com/gmackie/forgec/issues/44), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F44-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/adjudication`. Hard package dependencies: `decision`, `entitlement`, `evidence`, `evaluation`, `fulfillment`, `ledger`, `delivery`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- AdjudicationCase.
- AdjudicationItem.
- Determination.
- AdjustmentReasonLink.
- AuthorizedOutcomeLink.
- SettlementLink.

Commands:

- Open adjudication.
- Associate entitlement.
- Evaluate item.
- Record determination.
- Authorize fulfillment.
- Link settlement.
- Deliver explanation.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain expense, warranty and preauthorization resources point to AdjudicationCase; typed requested-service details reference AdjudicationItem. Reasons reference specification/evidence through declared evaluation contracts rather than arbitrary JSON.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Open → evaluating → determined → authorized → fulfilled or settled, with rejected and cancelled alternatives. Nonfinancial preauthorization may finish at authorization. Reconsideration creates new decision/determination history; it does not mutate a completed settlement.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Determination records entitlement-qualified context and source-backed reasons.
- Decision owns decision facts and Ledger owns financial postings.
- Settlement references authorization and cannot exceed its defined scope.
- Typed claim or request payload remains domain owned.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F44-01` (compile, planned): adjudication case/determination model.
- `F44-02` (compile, planned): entitlement/coverage integration.
- `F44-03` (compile, planned): evidence/evaluation integration.
- `F44-04` (compile, planned): decision/reason linkage.
- `F44-05` (compile, planned): fulfillment/ledger settlement hooks.
- `F44-06` (fixture, planned): fixtures for expense, warranty and healthcare preauthorization.
- `F44-R01` (concurrency, planned): Retried settlement hook cannot create duplicate ledger postings.
- `F44-R02` (concurrency, planned): Concurrent determination cannot authorize contradictory terminal outcomes.
- `F44-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F44-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- expense reimbursement: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- warranty claim: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- healthcare preauthorization: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
