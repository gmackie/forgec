# artifact substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/artifact`. Initial release target: experimental `0.1.0`.
Source: [issue #27](https://github.com/gmackie/forgec/issues/27), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Artifact: stable logical identity
- ArtifactRevision: immutable digest, media type, byte size and sealed content reference
- ArtifactComponent: immutable parent revision to child revision membership

Artifact is mutable descriptive identity; revisions move Draft -> Published and become immutable. Publish validates a bounded, acyclic manifest closure. Typed application resources reference Artifact or ArtifactRevision. Optional source pin points only to Specification; execution/lineage provenance associations are upper-layer typed satellites, never reverse imports. Digest includes algorithm and canonical encoding; media type is normalized. Size uses bytes, never a domain quantity.

## Dependencies and composition

Frozen direct substrate dependencies: `specification`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- CreateArtifact
- PublishRevision(artifact, sealedContent, digest, mediaType, size, specificationPin?)
- AddManifestComponents before publication; GetRevision; ListRevisions

## Invariants

- Digest is verified against sealed bytes; byte size is nonnegative integer bytes
- Publication freezes revision metadata and component membership; component refs pin exact revisions
- Blob location changes do not change artifact identity or content digest
- Public capabilities reject update/delete of published revisions; governance protects content access
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F27-01 | compile | artifact + immutable revision model | passing (local) |
| F27-02 | runtime | content digest/media type/size semantics | passing (local) |
| F27-03 | runtime | blob/object-store integration | passing (local) |
| F27-04 | runtime | optional manifest/component representation | passing (local) |
| F27-05 | compile | provenance hooks | passing (local) |
| F27-06 | compile | typed sidecar usage from application resources | passing (local) |
| F27-07 | fixture | fixtures for build artifact, evidence artifact, generated asset and document | passing (local) |

## Executable verification

`node scripts/verify-foundation.mjs --package artifact --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.
