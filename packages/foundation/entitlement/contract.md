# entitlement substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/entitlement`. Initial release target: experimental `0.1.0`.
Source: [issue #30](https://github.com/gmackie/forgec/issues/30), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Entitlement: typed Participant holder, right, entitlement scope, quantity/unit and validity
- Obligation: typed Participant obligated party, requirement, obligation scope, quantity/unit and due date
- RightLifecycleEvent: issuance, revocation, expiry or renewal history

Entitlement uses Participant directly for holder identity. Scope is an entitlement-specific handle, linked by typed domain resources. Entitlement Active -> Revoked or Expired; renewal issues a successor, preserving the original. Obligation Open -> Discharged or Cancelled; overdue is derived from dueAt and terminal state. Issuance records actor/time and a required typed source satellite in the issuer package, in the same atomic closure when applicable. No Agreement or Decision import is permitted. Extensible rights/requirements are qualified domain vocabulary, not a foundation-wide enum.

## Dependencies and composition

Frozen direct substrate dependencies: `participation`.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- IssueEntitlement; RecordObligation; RevokeEntitlement; ExpireEntitlement
- RenewEntitlement(old, newValidity); DischargeObligation; CancelObligation
- ListEffectiveRights(holder, scope, instant); ReadPipFacts

## Invariants

- Entitlement and participation are separate facts and neither is an authorization decision
- Rights, requirements and conditions use typed domain details, not policy language or arbitrary JSON
- Quantities use exact decimals with explicit domain unit and nonnegative bounds; no implicit unit conversion
- Renewal creates linked history; source agreement/decision/purchase associations are upper-layer typed satellites
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F30-01 | compile | entitlement model | planned |
| F30-02 | compile | obligation model | planned |
| F30-03 | runtime | validity/revocation/expiry semantics | planned |
| F30-04 | runtime | quantity/scoped-right support without becoming a ledger | planned |
| F30-05 | compile | source/provenance relation | planned |
| F30-06 | fixture | Gatekeeper PIP example | planned |
| F30-07 | fixture | fixtures for software seat, warranty, course access and contractual obligation | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `software-seat`, `warranty`, `course-access`, `contractual-obligation`, `entitlement-pip`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/entitlement/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/entitlement/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/entitlement/fixtures/consumer --out /tmp/foundation-entitlement-build
node scripts/verify-foundation.mjs --package entitlement --suite local
node scripts/verify-foundation.mjs --package entitlement --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.

## Expanded identity boundary (#52)

Party owns business actor identity. Holder, obligated party and agreement-party references use Party directly; Participation is only required where role/membership facts are used. Dependencies: party.
