# reconciliation contract

Phase 0 design contract for [issue #46](https://github.com/gmackie/forgec/issues/46), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F46-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/reconciliation`. Hard package dependencies: `specification`, `evaluation`, `fulfillment`, `evidence`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- DesiredRevision.
- ObservedEvaluationLink.
- Drift.
- ReconciliationAttempt.
- ReconciliationResult.

Commands:

- Set desired revision.
- Record observation.
- Compare desired and observed.
- Start corrective attempt.
- Record attempt result.
- Reobserve.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain-owned observed state references evaluation/observation envelope. Typed drift detail references Drift. Higher wrappers may join Change; Reconciliation never imports Change. Actor/workflow behavior is stateless library composition.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Desired revision is pending, converging or converged based on observations; attempts are pending, running, succeeded, failed or superseded. A newer desired revision fences old attempt completion. Polling/retry policy does not manufacture a successful result.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Desired revisions and observations remain durable history.
- Corrective attempts are fenced against the desired revision they read.
- Repeated reconciliation is idempotent for logical attempt identity.
- Drift explanations use semantic fields or anchors with provenance.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F46-01` (compile, planned): desired revision model.
- `F46-02` (compile, planned): observation/evaluation linkage.
- `F46-03` (compile, planned): structured drift representation.
- `F46-04` (compile, planned): reconciliation attempt/result.
- `F46-05` (compile, planned): actor/workflow pattern integration.
- `F46-06` (compile, planned): source-map/semantic-anchor explanation hooks.
- `F46-07` (fixture, planned): fixtures for ForgeGraph deployment, device config and repository policy.
- `F46-R01` (concurrency, planned): Stale controller cannot overwrite a newer desired revision.
- `F46-R02` (concurrency, planned): Crash and retry preserves attempt/result history and fence.
- `F46-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F46-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- ForgeGraph deployment: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- device configuration: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- repository policy: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
