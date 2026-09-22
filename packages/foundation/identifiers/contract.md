# identifiers substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
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

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F28-01 | compile | qualified identifier model | planned |
| F28-02 | concurrency | uniqueness/scoping semantics | planned |
| F28-03 | runtime | validity/supersession semantics | planned |
| F28-04 | runtime | typed lookup surfaces | planned |
| F28-05 | compile | no collision with Forge semantic ids | planned |
| F28-06 | fixture | fixtures for GitHub mapping, serial number and healthcare-style identifier | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `github-mapping`, `serial-number`, `healthcare-identifier`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/identifiers/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/identifiers/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/identifiers/fixtures/consumer --out /tmp/foundation-identifiers-build
node scripts/verify-foundation.mjs --package identifiers --suite local
node scripts/verify-foundation.mjs --package identifiers --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
