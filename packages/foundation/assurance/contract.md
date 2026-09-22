# assurance contract

Phase 0 design contract for [issue #40](https://github.com/gmackie/forgec/issues/40), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F40-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/assurance`. Hard package dependencies: `specification`, `evaluation`, `evidence`, `artifact`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Finding.
- Disposition.
- Remediation.
- Attestation.

Commands:

- Record finding.
- Record disposition.
- Open remediation.
- Link re-evaluation.
- Issue attestation.
- Supersede or revoke attestation.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain vulnerability, control and quality details reference Finding. Domain-owned remediation intent and fulfillment bridges reference Remediation and Fulfillment; assurance has no hard fulfillment dependency.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Finding is open then dispositioned; remediation is proposed, active then completed or cancelled. Re-evaluation establishes whether a correction succeeded. Attestations may expire, be revoked or superseded with retained history. Dispositions can require domain approval without making Decision a core dependency.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Finding lifecycle is independent of EvaluationRun phase.
- Disposition records remediate, accepted, false-positive, waived or deferred with reasons.
- Attestation fixes issuer, qualification, evidence pins and validity.
- Re-evaluation links to original finding and remediation without erasing earlier conclusions.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F40-01` (runtime, planned): Finding resource/lifecycle.
- `F40-02` (compile, planned): Disposition model.
- `F40-03` (runtime, planned): Remediation resource/lifecycle.
- `F40-04` (compile, planned): re-evaluation linkage.
- `F40-05` (compile, planned): Attestation envelope.
- `F40-06` (compile, planned): evidence/specification integration.
- `F40-07` (fixture, planned): fixtures for vulnerability, manufacturing CAPA, access review and model assurance.
- `F40-R01` (runtime, planned): Expired or superseded attestation does not appear current.
- `F40-R02` (runtime, planned): Conflicting disposition updates cannot overwrite history.
- `F40-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F40-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- vulnerability: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- manufacturing CAPA: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- access review: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- model assurance: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
