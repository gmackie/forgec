# fulfillment substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/fulfillment`. Initial release target: experimental `0.1.0`.
Source: [issue #31](https://github.com/gmackie/forgec/issues/31), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- FulfillmentSet: intent-side grouping handle
- Fulfillment: phase, optional specification pin, evidence bundle, executor and timing
- FulfillmentReplacement: explicit predecessor/successor relationship

App intent points to FulfillmentSet; typed detail points to Fulfillment. Planned -> Running -> Completed or Failed; Planned/Running -> Cancelled. Terminals are retained; reattempt creates a linked fulfillment. A partial result may complete one fulfillment while domain intent remains open. Executor uses a fulfillment-specific handle and typed runtime/Principal satellite; no Participation dependency is silently added. Evidence and source pin are explicit references; quantities are typed domain satellites. Queue adapter verification remains blocked until real kernel workQueue support is available.

## Dependencies and composition

Frozen direct substrate dependencies: `specification`, `evidence`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- CreateFulfillment(set, specificationPin?, evidenceBundle?)
- StartFulfillment; CompleteFulfillment; FailFulfillment; CancelFulfillment
- RecordReplacement; ListByIntentSet

## Invariants

- Domain owns request payload, partial quantities, business status and typed outcome satellites
- Multiple fulfillments share a set; retries preserve intent identity and cannot erase earlier attempts
- Replacement points within the same intent set and cannot form a cycle
- Execution task failure/cancellation is not automatically business completion or cancellation
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F31-01 | compile | fulfillment envelope | planned |
| F31-02 | compile | relation to domain-owned request/intent | planned |
| F31-03 | runtime | multiple/partial/replacement fulfillment semantics | planned |
| F31-04 | fixture | workQueue integration example | planned |
| F31-05 | fixture | typed outcome satellite example | planned |
| F31-06 | fixture | fixtures for Bob development run, lab service and provisioning | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `bob-development-run`, `lab-service`, `provisioning`, `workqueue-adapter`, `typed-outcome`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/fulfillment/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/fulfillment/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/fulfillment/fixtures/consumer --out /tmp/foundation-fulfillment-build
node scripts/verify-foundation.mjs --package fulfillment --suite local
node scripts/verify-foundation.mjs --package fulfillment --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.

## Executable profile

See [README.md](README.md) for append-only phase observations, terminal-wins semantics, domain-owned partial accounting, immutable replacements and the actual WorkQueue bridge. Consumer tests build all imported dependencies and run on memory/SQLite; live provider evidence and real Bob adoption are not claimed.
