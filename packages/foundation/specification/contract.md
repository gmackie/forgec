# specification substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/specification`. Initial release target: experimental `0.1.0`.
Source: [issue #26](https://github.com/gmackie/forgec/issues/26), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Repository: stable source repository identity independent of provider URL
- SpecificationPin: repository + semantic anchor + complete Git commit object ID
- Realization: source pin + buildHash + published manifest digest

No mutable specification lifecycle: resolve, then record an immutable pin; new source produces a new pin. Repository is owned here as source identity, not a source-control account. Domain instances point to pins. Realization records have no Artifact back-reference: ArtifactRevision points to the pin/realization and carries the published digest. Pin queries are bounded and indexed. No quantity units apply.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- ResolveSelector(repository, anchor, selector) -> immutable pin via declared provider adapter
- RecordRealization(pin, buildHash, manifestDigest)
- ListBySpecification(repository, anchor); ListByRevision(pin); ResolveSourceSpan(pin)

## Invariants

- Branches, tags and latest are discovery inputs only, never stored durable revisions
- Source commit, compiled semantic hash and content digest remain distinct typed values
- File movement preserves identity when semantic anchor is preserved; instances never float
- Provider resolution and source-map lookup cannot silently substitute another commit
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F26-01 | compile | typed immutable specification pin | planned |
| F26-02 | provider | mutable selector -> immutable commit resolution API | planned |
| F26-03 | compile | no durable branch/tag pins | planned |
| F26-04 | compile | semantic-anchor integration with source-map work | planned |
| F26-05 | runtime | realization/artifact provenance link | planned |
| F26-06 | compile | source-control provider abstraction remains outside business semantics | planned |
| F26-07 | fixture | fixtures proving old instances remain pinned after spec evolution | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `forgegraph-deployment`, `levelforge-generation`, `latchflow-experience`, `stream-conductor-broadcast`, `evaluation-definition`, `manufacturing-recipe`, `lab-protocol`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/specification/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/specification/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/specification/fixtures/consumer --out /tmp/foundation-specification-build
node scripts/verify-foundation.mjs --package specification --suite local
node scripts/verify-foundation.mjs --package specification --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
