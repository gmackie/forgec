# operations contract

Phase 0 design contract for [issue #45](https://github.com/gmackie/forgec/issues/45), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F45-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/operations`. Hard package dependencies: `specification`, `allocation`, `fulfillment`, `usage`, `lineage`, `evaluation`, `evidence`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Operation.
- OperationRun.
- PlannedAllocationLink.
- ActualAllocationLink.
- OperationFulfillmentLink.
- OperationUsageLink.
- OperationLineageLink.

Commands:

- Plan operation.
- Reserve resources.
- Start run.
- Link execution tasks.
- Record actual usage.
- Record inputs and outputs.
- Evaluate run.
- Complete or cancel run.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain manufacturing, laboratory, development and media work payloads reference Operation/OperationRun. Typed outputs own their data and connect to LineageNode. Queue adapters link through kernel execution contracts, not a universal Task schema.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Planned → allocated → running → evaluating → completed or failed/cancelled. Partial work retains actual usage and output lineage. Cancelling releases unused reservations according to Allocation policy and never erases consumption.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Business operation identity is distinct from workQueue task identity.
- One run can span multiple execution tasks and fulfillments.
- Planned resources remain distinct from actual consumption.
- Usage and lineage retain durable source identities across retries.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F45-01` (compile, planned): operation/run envelope.
- `F45-02` (compile, planned): specification pin.
- `F45-03` (compile, planned): planned vs actual allocations.
- `F45-04` (compile, planned): fulfillment/workQueue linkage.
- `F45-05` (compile, planned): usage + lineage recording.
- `F45-06` (compile, planned): evaluation/evidence linkage.
- `F45-07` (fixture, planned): fixtures for manufacturing run, lab run, Bob development run and media/stream production.
- `F45-R01` (concurrency, planned): Retried execution does not double-record usage.
- `F45-R02` (concurrency, planned): Cancel and complete races release reservations at most once.
- `F45-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F45-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- manufacturing run: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- lab run: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- Bob development run: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- media/stream production: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
