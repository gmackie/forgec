# evaluation substrate contract

Experimental local implementation. All six acceptance cases execute generated memory/SQLite bundles; hosted providers are not certified.
Logical Forge identity: `@forgegraph/foundation/evaluation`. Initial release target: experimental `0.1.0`.
Source: [issue #32](https://github.com/gmackie/forgec/issues/32), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- EvaluationRun: immutable definition pin, operational phase, timing and executor
- EvaluationSet: subject-owned run grouping sidecar
- EvaluationRunEvidence: exact evidence-bundle association

Subject points to EvaluationSet; a typed satellite may reference both run and subject for precise association. Phase is derived from immutable facts: Planned → Running → Completed or Failed; Planned/Running → Cancelled. Unique terminal facts win over concurrently recorded start intents. Domain verdict (for example unacceptable quality) may accompany Completed execution. Executor is an evaluation-specific handle with typed adapter satellite. Parent run/batch membership must be bounded and acyclic. Reproducibility metadata uses pinned typed configuration satellites; domain measurements retain explicit units outside this envelope.

## Dependencies and composition

Frozen direct substrate dependencies: `specification`, `evidence`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- CreateEvaluationRun(set, pin); StartEvaluation; CompleteEvaluation
- FailEvaluation; CancelEvaluation; ListRunsByDefinition; ListRunsBySet

## Invariants

- Every run pins definition before execution; new definition never changes old runs
- Typed domain observations/verdict reference EvaluationRun; no universal Result or key/JSON Observation
- Operational completion is distinct from pass/fail or domain qualification verdict
- Evidence attachments preserve exact support and governance; terminal run metadata is immutable
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F32-01 | compile | EvaluationRun envelope | planned |
| F32-02 | compile | definition/specification pin integration | planned |
| F32-03 | compile | typed observation/result satellite idiom | planned |
| F32-04 | runtime | evidence integration | planned |
| F32-05 | compile | generic phase vs business-status guidance | planned |
| F32-06 | fixture | fixtures for ForgeGraph verification, LevelForge candidate evaluation, LLM eval and manufacturing inspection | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `forgegraph-verification`, `levelforge-candidate`, `llm-evaluation`, `manufacturing-inspection`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/evaluation/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/evaluation/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/evaluation/fixtures/consumer --out /tmp/foundation-evaluation-build
node scripts/verify-foundation.mjs --package evaluation --suite local
node scripts/verify-foundation.mjs --package evaluation --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
