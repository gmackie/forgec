# ledger substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/ledger`. Initial release target: experimental `0.1.0`.
Source: [issue #36](https://github.com/gmackie/forgec/issues/36), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Account: ledger-specific fungible quantity identity and unit/currency
- PostingGroup: immutable atomic group with balancing policy
- Entry: signed exact quantity posting; reversal link
- Balance: derived rebuildable projection, never independent truth

Domain resources reference Account or typed source-to-PostingGroup satellite. Posting validates bounded input and becomes Posted atomically; no partially posted externally visible state. Reversal records a new group; original remains Posted with derived reversal association. Exact signed decimals use account scale and explicit unit; currencies are typed units, and transfers cannot cross them without explicit separate conversion postings. Balance limits, if configured, require same-commit versioned account guards. Derived balance caches alone cannot authorize withdrawals. No Usage or Allocation import: rating/reservation associations belong above.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- OpenAccount; PostGroup(entries, policy, idempotencyKey)
- ReverseGroup(original, reason); CorrectWithNewGroup
- ReadBalance; RebuildBalances

## Invariants

- Posted groups and entries reject update/delete through every exposed capability
- Balanced groups sum to zero per exact unit/currency; no binary floating-point arithmetic or implicit exchange
- All entries, account guards and idempotency receipt commit atomically within provider budget
- Reversals are new linked postings, prevent repeated reversal of the same amount, and preserve originals
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F36-01 | compile | account/entry model | planned |
| F36-02 | runtime | immutable posting semantics | planned |
| F36-03 | runtime | reversal/correction semantics | planned |
| F36-04 | runtime | balance projection | planned |
| F36-05 | concurrency | atomic posting-group semantics | planned |
| F36-06 | provider | concurrency conformance across supported stores | planned |
| F36-07 | fixture | fixtures for money, inventory quantity and compute credits | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `money`, `inventory-quantity`, `compute-credits`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/ledger/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/ledger/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/ledger/fixtures/consumer --out /tmp/foundation-ledger-build
node scripts/verify-foundation.mjs --package ledger --suite local
node scripts/verify-foundation.mjs --package ledger --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
