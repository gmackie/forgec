# delivery substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/delivery`. Initial release target: experimental `0.1.0`.
Source: [issue #38](https://github.com/gmackie/forgec/issues/38), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- DeliveryIntent: logical send identity, typed destination handle and pinned payload association
- DeliveryAttempt: append-only numbered execution history and provider reference
- DeliveryReceipt: acknowledgment/failure/uncertain outcome with evidence

Destination is a delivery-specific handle; channel/provider details are typed adapter satellites and contain no embedded credentials. Intent Pending -> Sending -> Acknowledged or Failed; uncertain provider result -> Uncertain -> Acknowledged/Failed after reconciliation. Retry adds an attempt under explicit bounded retry policy; cancellation is allowed only before a send claim or after an explicitly reconciled failure. Attempt Started -> Succeeded, Failed or Uncertain. Provider reference and evidence receipt remain durable; external SDK call is outside local transaction. Timeouts do not prove no send occurred. No quantity units; payload bytes are governed by Artifact.

## Dependencies and composition

Frozen direct substrate dependencies: `artifact`, `evidence`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- CreateDeliveryIntent(destination, payloadRevision?, idempotencyKey)
- BeginAttempt; RecordAttemptFailure; RecordReceipt; MarkUncertain
- RetryDelivery; CancelPendingDelivery; ReconcileProviderOutcome

## Invariants

- Intent deduplication is separate from provider side-effect idempotency; no universal exactly-once promise
- Attempt numbering and claim are conditional; retry never overwrites attempt history
- Callbacks deduplicate by provider receipt identity; stale callbacks cannot downgrade a final acknowledgment
- Artifact payload pins exact revision; typed content satellite may supply non-artifact payload without arbitrary JSON
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F38-01 | compile | DeliveryIntent model | planned |
| F38-02 | compile | DeliveryAttempt model | planned |
| F38-03 | runtime | DeliveryReceipt/result semantics | planned |
| F38-04 | concurrency | idempotency and retry history | planned |
| F38-05 | runtime | provider-reference/provenance support | planned |
| F38-06 | runtime | evidence/artifact integration | planned |
| F38-07 | fixture | fixtures for email, webhook and file export | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `email`, `webhook`, `file-export`, `ambiguous-provider-success`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/delivery/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/delivery/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/delivery/fixtures/consumer --out /tmp/foundation-delivery-build
node scripts/verify-foundation.mjs --package delivery --suite local
node scripts/verify-foundation.mjs --package delivery --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
