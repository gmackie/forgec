# participation substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/participation`. Initial release target: experimental `0.1.0`.
Source: [issue #29](https://github.com/gmackie/forgec/issues/29), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Party: imported durable business identity owned by Party
- ParticipationSet: application-owned scope sidecar
- Participation: participant + role + set + validity + recorded provenance

Party owns business actor identity and Principal representation. Entitlement imports Party directly and does not require membership. Scope is ParticipationSet: app resources point outward to it. Participation begins Active and ends Ended or Revoked; validity can expire without deleting history. Duplicate active participant/role/window policy is explicit per set and must reject conflicting overlap where uniqueness is selected. Source attribution uses actor and recorded time; business source associations are domain satellites. No quantity units.

## Dependencies and composition

Frozen direct substrate dependencies: `party`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- AddParticipation(set, participant, role, validity)
- EndParticipation; RevokeParticipation; ListParticipantsAt(set, instant)
- ReadParticipationFacts for Gatekeeper PIP

## Invariants

- participant is a typed Party reference; Party owns Principal representation while domain Person/Organization details are typed satellites
- Role vocabulary is owned by the consuming package, namespaced and validated through its typed wrapper
- Validity is half-open; ended/revoked history remains queryable
- Participation alone never grants authority; tenant and governance checks apply to PIP reads
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F29-01 | compile | participation aggregate and validity semantics | passing (local) |
| F29-02 | compile | role vocabulary extension mechanism | passing (local) |
| F29-03 | compile | typed participant identity strategy | passing (local) |
| F29-04 | runtime | participation lookup/projection surfaces | passing (local) |
| F29-05 | fixture | Gatekeeper/PIP integration example | passing (local) |
| F29-06 | fixture | team, classroom and review-board fixtures | passing (local) |

## Executable verification

`node scripts/verify-foundation.mjs --package participation --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.
