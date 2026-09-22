# experiment contract

Phase 0 design contract for [issue #42](https://github.com/gmackie/forgec/issues/42), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F42-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/experiment`. Hard package dependencies: `specification`, `participation`, `allocation`, `fulfillment`, `evaluation`, `evidence`, `artifact`, `lineage`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Experiment.
- ExperimentVariant.
- ExperimentAssignment.
- ExperimentEvaluationLink.

Commands:

- Register experiment.
- Register variant.
- Assign subject or run.
- Record assignment provenance.
- Link intervention fulfillment.
- Link evaluation.
- Close experiment.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain subject/run details reference ExperimentAssignment. Typed analysis satellites reference experiment or evaluation. Produced artifacts retain Artifact identity and connect through LineageNode handles, not generic targets.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Draft → active → closed or cancelled. Variant definitions and assignment method are frozen before active assignment; any amendment receives explicit revision provenance. Reassignment requires a retained superseding assignment and an explicit policy, not an in-place variant change.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Assignment is an authoritative fact distinct from evaluation result.
- Assignment records method and seed or provenance where applicable.
- Assignments reference variants belonging to the same experiment.
- Analysis and outcome payloads remain typed domain facts.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F42-01` (runtime, planned): Experiment/Variant/Assignment model.
- `F42-02` (compile, planned): specification pin.
- `F42-03` (runtime, planned): assignment provenance/randomization metadata.
- `F42-04` (compile, planned): evaluation linkage.
- `F42-05` (compile, planned): artifact/lineage linkage.
- `F42-06` (fixture, planned): fixtures for A/B test, LLM eval comparison, LevelForge candidate comparison and manufacturing DOE.
- `F42-R01` (concurrency, planned): Duplicate assignment request creates one assignment.
- `F42-R02` (concurrency, planned): Concurrent scarce-resource assignments cannot overallocate.
- `F42-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F42-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- A/B test: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- LLM evaluation comparison: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- LevelForge candidate comparison: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- manufacturing DOE: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
