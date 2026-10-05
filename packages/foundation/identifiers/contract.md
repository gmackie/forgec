# identifiers substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/identifiers`. Initial release target: experimental `0.1.0`.
Source: [issue #28](https://github.com/gmackie/forgec/issues/28), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- IdentifierSet: sidecar attached by canonical application resource
- Identifier: namespace, value, optional issuer, scope, validity and supersession

IdentifierSet is the substrate handle; there is no universal owner pointer or global external-ID lookup. Namespace owns normalization and issuer rules. Active -> Superseded or Revoked; expired validity is evaluated at query time. Reuse requires a future explicit policy revision, not an implicit expiry side effect. Optional issuer identity uses an identifier-specific Issuer handle with typed domain satellite, not EntityRef. No numeric quantity semantics.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- AssignIdentifier(set, namespace, value, issuer?, validFrom?, validUntil?)
- SupersedeIdentifier(old, replacement); RevokeIdentifier
- LookupQualified(namespace, issuer?, value, at); ListBySet

## Invariants

- Canonical Forge record and semantic IDs are never replaced by alternate identifiers
- Uniqueness is tenant + namespace + issuer identity + normalized value; absent issuer has explicit namespace scope
- Validity uses half-open intervals and does not silently release uniqueness for reuse
- Supersession is explicit history; typed lookup returns IdentifierSet and domain resolves its typed owner
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F28-01 | compile | qualified identifier model | passing (local) |
| F28-02 | concurrency | uniqueness/scoping semantics | passing (local) |
| F28-03 | runtime | validity/supersession semantics | passing (local) |
| F28-04 | runtime | typed lookup surfaces | passing (local) |
| F28-05 | compile | no collision with Forge semantic ids | passing (local) |
| F28-06 | fixture | fixtures for GitHub mapping, serial number and healthcare-style identifier | passing (local) |

## Executable verification

`node scripts/verify-foundation.mjs --package identifiers --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.
