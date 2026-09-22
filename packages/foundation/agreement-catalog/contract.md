# agreement-catalog contract

Phase 0 design contract for [issue #43](https://github.com/gmackie/forgec/issues/43), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F43-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/agreement-catalog`. Hard package dependencies: `decision`, `specification`, `participation`, `entitlement`, `evaluation`, `artifact`, `evidence`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Catalog.
- CatalogEntry.
- Offer.
- Agreement.
- AgreementParticipant.
- AgreementTermLink.
- AgreementEntitlementLink.
- AgreementObligationLink.

Commands:

- Publish offer.
- Qualify selection.
- Accept agreement.
- Issue rights and duties.
- Suspend agreement.
- Resume agreement.
- Terminate agreement.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Commercial, clinical and educational term details are typed satellites. Pricing or rating is an imported domain contract, not a new foundation policy language. Agreement owns source links to issued rights; Entitlement never imports Agreement.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Offers have explicit availability and validity. Agreements move proposed → active → suspended or terminated; expiry is explicit. Contract policy specifies the effective rights/duties effects of suspension, resumption and termination without rewriting issuance history.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Offer is distinct from its specification.
- Agreement is distinct from its qualification Decision.
- Terms retain exact specification and artifact pins.
- Accepting an agreement issues linked entitlements and obligations once.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F43-01` (compile, planned): Catalog/Entry/Offer model.
- `F43-02` (compile, planned): Agreement + participant integration.
- `F43-03` (runtime, planned): entitlements/obligations issued from agreement.
- `F43-04` (runtime, planned): validity/suspension/termination lifecycle.
- `F43-05` (compile, planned): specification/artifact term pinning.
- `F43-06` (fixture, planned): fixtures for SaaS plan, course offering, lab service and vendor agreement.
- `F43-R01` (concurrency, planned): Concurrent acceptance cannot duplicate rights or duties.
- `F43-R02` (runtime, planned): Expired offer cannot be accepted without a new valid offer.
- `F43-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F43-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- SaaS plan: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- course offering: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- lab service: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- vendor agreement: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
