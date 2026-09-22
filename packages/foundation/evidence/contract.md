# evidence substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/evidence`. Initial release target: experimental `0.1.0`.
Source: [issue #33](https://github.com/gmackie/forgec/issues/33), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- EvidenceBundle: subject-side support aggregate
- EvidenceItem: source identity, classification, observedAt, artifact revision or typed source satellite

Bundle Open -> Sealed; sealed items and membership are immutable. Corrections produce successor bundle/items with explicit predecessor relation. Evidence source actor/time is envelope metadata; a domain-owned typed satellite identifies external record/execution source without importing upper layers. Digest is optional for non-byte evidence and must match referenced revision where present. observedAt and recordedAt are distinct. No quantity units apply.

## Dependencies and composition

Frozen direct substrate dependencies: `artifact`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- CreateEvidenceBundle; AppendEvidenceItem; SealEvidenceBundle
- ReadEvidence; ListItems; CreateSuccessorBundle

## Invariants

- Subject points outward to bundle; Evidence never stores arbitrary subject type/id
- Artifact-backed item pins an immutable ArtifactRevision and preserves its digest
- Typed domain source satellite replaces polymorphic references; observations remain distinct from evaluation results
- Classification and access rules apply to metadata as well as bytes; sealed support cannot be silently replaced
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F33-01 | compile | EvidenceBundle + EvidenceItem model | planned |
| F33-02 | runtime | artifact/reference integration | planned |
| F33-03 | runtime | provenance/source semantics | planned |
| F33-04 | runtime | governance/data-classification behavior | planned |
| F33-05 | compile | sidecar attachment idiom | planned |
| F33-06 | fixture | fixtures for deployment verification, manufacturing inspection and agent review | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `deployment-verification`, `manufacturing-inspection`, `agent-review`, `confidential-evidence`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/evidence/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/evidence/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/evidence/fixtures/consumer --out /tmp/foundation-evidence-build
node scripts/verify-foundation.mjs --package evidence --suite local
node scripts/verify-foundation.mjs --package evidence --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
