# ledger substrate contract

Executable sealed-group profile; provider acceptance remains **planned** until independent evidence is registered.
Logical Forge identity: `@forgegraph/foundation/ledger`. Initial release target: experimental `0.1.0`.
Source: [issue #36](https://github.com/gmackie/forgec/issues/36), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Account: ledger-specific fungible quantity identity and unit/currency
- PostingGroup: immutable atomic group with balancing policy
- Entry: signed exact quantity posting; reversal link
- Balance: derived rebuildable projection, never independent truth

Domain resources reference Account or typed source-to-PostingGroup satellite. Posting validates bounded input and becomes Posted atomically; no partially posted externally visible state. Reversal records a new group; original remains Posted with derived reversal association. Exact signed decimals use six decimal places and explicit unit; currencies are typed units, and transfers cannot cross them without explicit separate conversion postings. Balance limits and withdrawal authorization are outside this profile. Derived balance caches alone cannot authorize withdrawals. No Usage or Allocation import: rating/reservation associations belong above.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

`Account.create` opens an account. Runtime `Ledger.post`, `reverse`, `balance`, and `rebuild` implement the profile; a correction is a reversal followed by a new group, with each group independently atomic:

- OpenAccount; PostGroup(entries, policy, idempotencyKey)
- ReverseGroup(original, reason); CorrectWithNewGroup
- ReadBalance; RebuildBalances

## Invariants

- Posted groups and entries reject update/delete through every exposed capability
- Balanced groups sum to zero per exact unit/currency; no binary floating-point arithmetic or implicit exchange
- Candidate entries become posted together through one unique immutable publication seal; consuming helpers revalidate the complete chain
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

## Implemented publication profile

The helper accepts 1–128 immutable candidate entries per group and reads at most 512 published groups per book. Candidate entries never affect balance. A single append-only PostingGroup selects the complete chain, protected by unique `(book,key)` and `(book,claim)` constraints. Claims distinguish ordinary group keys from reversal identities; competing reversals of one original can publish only once. Idempotent same-key retries compare normalized entries, policy, original reference and reason. Reversal is whole-group, preserves originals, and cannot reverse a reversal.

Every authoritative balance and helper publication reads and validates all published groups, including exact per-unit balancing and inverse per-account reversal totals. Direct low-level CRUD can create a structurally valid but economically invalid seal; authoritative consumers fail closed on it. Applications must use these helpers for balances and treat raw Entry and PostingGroup list results as facts requiring validation. Access-hidden publications fail closed rather than silently disappear from totals. Restart rebuild uses durable groups and BigInt arithmetic. Returned group IDs identify the records observed; concurrent scans are not a serializable global snapshot.

Account unit strings are explicit and immutable; consumers own the unit vocabulary. Balanced groups sum to zero independently per unit. `unrestricted` permits single-sided issuance/consumption with the same immutable semantics. No exchange-rate conversion, account overdraft guarantee, cross-book atomic transaction, partial reversal, persistent balance cache, or unbounded scan is claimed. Exceeding the read budget fails closed. Candidate facts can remain after failed or concurrent retries.

Local verification: generated consumer bundle with typed money, inventory and compute-credit satellites; real Engine operations against MemoryStorage and SQLite-backed D1Storage. Live D1/Postgres/DynamoDB verification is separate and remains planned.
