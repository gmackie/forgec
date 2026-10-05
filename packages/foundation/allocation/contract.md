# allocation substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/allocation`. Initial release target: experimental `0.1.0`.
Source: [issue #34](https://github.com/gmackie/forgec/issues/34), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Pool: exclusive or fungible capacity with explicit unit and version guard
- Reservation: held business capacity and validity window
- Allocation: committed ownership claim linked to reservation; release/expiry history

App resource references an Allocation-specific Pool; typed satellite relates physical resource to that pool. Reservation Held -> Allocated, Cancelled or Expired; Allocation Active -> Released or Expired. A held claim already consumes capacity and allocation must not double count it. Validity is half-open and clocks are injectable. A versioned pool guard serializes overlapping-window checks against all relevant bounded claims; unsupported unbounded windows/claim counts are rejected. No Ledger dependency: optional quantity backing is a higher typed bridge. Kernel must prove conditional guards, staged refs, rollback and budgets on D1/Postgres/Dynamo before this contract can pass.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- Reserve(pool, quantity, unit, window, idempotencyKey)
- Allocate(reservation); Release; CancelReservation; ExpireReservation
- ListClaimsAt(pool, instant); ReadAvailableCapacity

## Invariants

- Reserve mutates pool capacity guard and claim in one atomic commit; pre-write list alone is insufficient
- For each instant, live reservations and allocations never exceed declared capacity; exclusive pool capacity is one
- Release, cancellation and expiry compete conditionally and release capacity at most once
- Exact positive quantity/unit required; provider budget overflow rejects before any mutation
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F34-01 | compile | pool/capacity model | planned |
| F34-02 | concurrency | atomic reservation semantics | planned |
| F34-03 | runtime | allocation/release/expiry lifecycle | planned |
| F34-04 | fixture | exclusive and quantity-based fixtures | planned |
| F34-05 | provider | concurrency conformance on D1/Postgres/Dynamo targets | planned |
| F34-06 | fixture | fixtures for Runner/GPU, hospital bed and machine reservation | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `runner-gpu`, `hospital-bed`, `machine-reservation`, `fungible-capacity`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/allocation/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/allocation/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/allocation/fixtures/consumer --out /tmp/foundation-allocation-build
node scripts/verify-foundation.mjs --package allocation --suite local
node scripts/verify-foundation.mjs --package allocation --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.

## Implemented single-row journal profile

The original mutable-pool-plus-claim algorithm is replaced by a unique pool-ordinal journal entry that commits guard and transition together through Engine. [README.md](README.md) defines the mandatory validated-consumer boundary, raw candidate poison handling, bounded history, trusted-clock assumption and remaining kernel/provider gates. Acceptance statuses remain planned until evidence is registered.

## Atomic multi-pool composition

`Allocations.prepare` now accepts a bounded set of one command per distinct pool and returns operation descriptors for `Engine.atomic`; callers must commit the complete set with their publication facts. `book` directly accepts a durable reservation candidate as allocated, and `replace` atomically releases an allocated original and accepts a durable replacement in the same pool journal row. Whole-interval capacity is checked against the resulting state. `reservation` exposes validated lifecycle and immutable command evidence. Existing `act` commands remain one-pool operations; sequential `act` calls do not provide multi-pool atomicity.
