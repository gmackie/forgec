# usage substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/usage`. Initial release target: experimental `0.1.0`.
Source: [issue #35](https://github.com/gmackie/forgec/issues/35), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- UsageStream: subject-owned metering handle
- UsageEvent: dimension, exact quantity/unit, point or interval, source event identity
- UsageCorrection: superseding/retracting relation preserving original consumption

Domain subject points to UsageStream; resource and meter details are typed satellites without importing Specification. Source is a usage-specific metering source handle, not a universal entity. Recorded -> Superseded or Retracted via new correction facts, not destructive edits; raw event remains unchanged. Nonnegative exact decimal measurements use explicit units and declared scale; correction carries replacement measurement rather than ambiguous signed deltas. Projections are rebuildable, tolerate stale event delivery, and never perform pricing or Ledger posting.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- IngestUsage(stream, source, eventKey, measurement)
- CorrectUsage(original, replacement); RetractUsage(original)
- AggregateUsage(stream, dimension, interval); RebuildUsageProjection

## Invariants

- Same tenant/source/event key and same payload are idempotent; conflicting payload is rejected
- Point event uses occurredAt; interval uses start/end with start < end and half-open semantics
- Raw measurements are immutable; corrections are new records and cannot form cycles
- Aggregation separates dimension/unit; derived totals can rebuild without double counting retractions
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F35-01 | compile | UsageEvent model | planned |
| F35-02 | compile | dimension/unit representation | planned |
| F35-03 | runtime | interval and point-event semantics | planned |
| F35-04 | concurrency | idempotent ingestion/source identity | planned |
| F35-05 | runtime | correction/supersession semantics | planned |
| F35-06 | runtime | aggregation projections | planned |
| F35-07 | fixture | fixtures for LLM tokens, compute time and machine hours | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `llm-tokens`, `compute-time`, `machine-hours`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/usage/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/usage/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/usage/fixtures/consumer --out /tmp/foundation-usage-build
node scripts/verify-foundation.mjs --package usage --suite local
node scripts/verify-foundation.mjs --package usage --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
