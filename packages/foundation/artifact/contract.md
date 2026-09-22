# artifact substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
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

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F27-01 | compile | artifact + immutable revision model | planned |
| F27-02 | runtime | content digest/media type/size semantics | planned |
| F27-03 | runtime | blob/object-store integration | planned |
| F27-04 | runtime | optional manifest/component representation | planned |
| F27-05 | compile | provenance hooks | planned |
| F27-06 | compile | typed sidecar usage from application resources | planned |
| F27-07 | fixture | fixtures for build artifact, evidence artifact, generated asset and document | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `build-artifact`, `evidence-artifact`, `generated-asset`, `document`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/artifact/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/artifact/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/artifact/fixtures/consumer --out /tmp/foundation-artifact-build
node scripts/verify-foundation.mjs --package artifact --suite local
node scripts/verify-foundation.mjs --package artifact --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
