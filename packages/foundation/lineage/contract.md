# lineage substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/lineage`. Initial release target: experimental `0.1.0`.
Source: [issue #37](https://github.com/gmackie/forgec/issues/37), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- LineageNode: substrate-specific handle owned by a typed domain resource
- LineageRelation: derived, aggregated, transformed, copied or extracted semantics
- Transformation: explicit input/output memberships and optional specification pin

Domain BuildArtifact/Dataset/Batch points to LineageNode. All relation kinds follow directed acyclic provenance in v0.1.0; physical recycling requires a new node identity. Relation Recorded -> Superseded through explicit correction facts; original remains readable. Optional SpecificationPin is direct; execution/artifact/fulfillment links use upper typed bridges to avoid cycles. Traversal returns typed nodes/relations with pagination and truncation metadata. Input/output amounts, yields and domain units belong to typed transformation satellites. Concurrent edge insertion must use a graph revision guard in the same atomic commit, not query-only cycle detection.

## Dependencies and composition

Frozen direct substrate dependencies: `specification`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- CreateLineageNode; RecordDerivation; RecordAggregation
- RecordTransformation(inputs, outputs, pin?); RecordCopy; RecordExtraction
- TraverseAncestors; TraverseDescendants with explicit bounds

## Invariants

- No generic relatedTo edge or polymorphic business resource pointer
- Aggregation retains constituent identity; transformation has explicit input/output sets and does not infer Cartesian edges
- Self-links and cycles are rejected with serialized graph guard; traversal and mutation have configured size/depth budgets
- Committed provenance is immutable; correction creates explicit superseding record
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F37-01 | compile | LineageNode/handle model | planned |
| F37-02 | runtime | explicit edge/relation semantics | planned |
| F37-03 | runtime | aggregation vs transformation distinction | planned |
| F37-04 | compile | execution/specification provenance | planned |
| F37-05 | runtime | graph traversal/read models | planned |
| F37-06 | concurrency | cycle/size safety | planned |
| F37-07 | fixture | fixtures for software build, manufacturing batch, dataset transform and LevelForge generation | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `software-build`, `manufacturing-batch`, `dataset-transform`, `levelforge-generation`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/lineage/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/lineage/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/lineage/fixtures/consumer --out /tmp/foundation-lineage-build
node scripts/verify-foundation.mjs --package lineage --suite local
node scripts/verify-foundation.mjs --package lineage --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
