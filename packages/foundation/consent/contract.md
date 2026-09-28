# consent substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/consent`. Initial release target: experimental `0.1.0`.
Source: [issue #93](https://github.com/gmackie/forgec/issues/93), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- ConsentSubject: sidecar attached by canonical application resource
- ConsentGrant: purpose, activity and scope, with valid time and knowledge time recorded separately
- ConsentEvidence: how the grant was captured
- ConsentDisposition: withdrawal or supersession, carrying both time axes

ConsentSubject is the substrate handle; there is no universal subject pointer and no global consent lookup. The domain resolves its own typed subject. Purpose, activity and scope are keyed registries rather than enums, so an application adds a processing activity without a language change. Counterparty and basis are keyed handles, not EntityRef. Active -> Withdrawn or Superseded; expiry is evaluated at query time. Re-consent after withdrawal is a new grant, never a revival of the old one. No numeric quantity semantics.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

Intake #60 may produce grants and owns none of them. A request-time policy engine may consume consent as a policy information point; it does not own consent state, and this contract authorizes no reverse edge from a decision back into a grant.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- Grant(subject, purpose, activity, scope, grantedTo?, basis?, conditions?, validFrom, validUntil?, recordedAt)
- AttachEvidence(grant, capturedAt, method, provenance)
- Withdraw(grant, effectiveAt, recordedAt, reason); Supersede(grant, replacement, effectiveAt, recordedAt, reason)
- EffectiveAt(subject, purpose, activity, scope, validAt, knownAt); ListBySubject

## Invariants

- Consent is not authorization: these facts are an input to a decision and a missing grant is the absence of an input, never a denial reason on its own
- Purpose, activity and scope are independent axes; agreeing to store for research is not agreeing to share, nor to store for marketing
- Valid time and knowledge time are separate: a grant counts only when it was in force at validAt and already recorded by knownAt, and a disposition suppresses it under the same two tests
- Withdrawal preserves history; a terminal disposition is unique per grant and must either withdraw or hand over to a replacement
- Notification preference, agreement and entitlement are different facts with different lifecycles and are not modelled here
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F93-01 | runtime | ConsentGrant durable fact. | passing (local) |
| F93-02 | runtime | Withdrawal and expiry preserve history. | passing (local) |
| F93-03 | runtime | Purpose and data/action scope are explicit. | passing (local) |
| F93-04 | runtime | Evidence/source is attachable. | passing (local) |
| F93-05 | fixture | ABAC/Gatekeeper PIP example. | passing (local) |
| F93-06 | fixture | Intake #60 can produce Consent without owning it. | passing (local) |
| F93-07 | compile | Notification preferences remain distinct from consent. | passing (local) |
| F93-08 | runtime | Temporal query can answer whether consent was valid and known at a past decision/access time. | passing (local) |

F93-05 is the policy-information-point pattern demonstrated over this substrate: a decision function reads consent as one input and records which grant it relied on. It is not an integration into `packages/runtime/src/gatekeeper.ts`, and this contract does not claim one.

F93-08 is satisfied by a bounded valid/knowledge interpretation built from ordinary fields. ConceptIR #75 would make those axes a language-level facet; this package's convention is a seam for that work and does not pre-empt it.

## Executable verification

`node scripts/verify-foundation.mjs --package consent --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.
