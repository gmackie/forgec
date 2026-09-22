# participation substrate contract

Phase 0 contract; implementation and every acceptance case remain **planned**.
Logical Forge identity: `@forgegraph/foundation/participation`. Initial release target: experimental `0.1.0`.
Source: [issue #29](https://github.com/gmackie/forgec/issues/29), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- Participant: participation-specific identity handle
- ParticipationSet: application-owned scope sidecar
- Participation: participant + role + set + validity + recorded provenance

Participant handle is shared with Entitlement under an explicit dependency; it is not a universal Party model. Scope is ParticipationSet: app resources point outward to it. Participation begins Active and ends Ended or Revoked; validity can expire without deleting history. Duplicate active participant/role/window policy is explicit per set and must reject conflicting overlap where uniqueness is selected. Source attribution uses actor and recorded time; business source associations are domain satellites. No quantity units.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- RegisterParticipant; AddParticipation(set, participant, role, validity)
- EndParticipation; RevokeParticipation; ListParticipantsAt(set, instant)
- ReadParticipationFacts for Gatekeeper PIP

## Invariants

- Participant is a typed handle, not resourceType plus id; Principal and organization/device mappings are typed satellites
- Role vocabulary is owned by the consuming package, namespaced and validated through its typed wrapper
- Validity is half-open; ended/revoked history remains queryable
- Participation alone never grants authority; tenant and governance checks apply to PIP reads
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses are planned. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F29-01 | compile | participation aggregate and validity semantics | planned |
| F29-02 | compile | role vocabulary extension mechanism | planned |
| F29-03 | compile | typed participant identity strategy | planned |
| F29-04 | runtime | participation lookup/projection surfaces | planned |
| F29-05 | fixture | Gatekeeper/PIP integration example | planned |
| F29-06 | fixture | team, classroom and review-board fixtures | planned |

## Independent verification contract

Package worker owns this directory, typed consumer fixtures, negative cases and generated-runtime tests. Materialize dependencies at accepted commits/digests in an isolated workspace. A separate worker reviews the resulting immutable commit. No package passes against handwritten dependency stubs.

Required fixture cases: `team`, `classroom`, `review-board`, `principal-pip`, `organization-participant`. These are required fixture identities, not existing files. App probes must record the actual source application revision; synthetic fixtures do not prove production adoption.

After executable sources and the Phase 1 harness exist, run:

```sh
cargo run -p forgegraph-cli -- check packages/foundation/participation/fixtures/consumer
cargo run -p forgegraph-cli -- fmt packages/foundation/participation/fixtures/consumer --check
cargo run -p forgegraph-cli -- build packages/foundation/participation/fixtures/consumer --out /tmp/foundation-participation-build
node scripts/verify-foundation.mjs --package participation --suite local
node scripts/verify-foundation.mjs --package participation --suite providers --require d1,postgres,dynamodb
```

The fixture paths and verification runner above are planned interfaces; they do not exist merely because this contract names them. Phase 0 verification only checks contract structure, frozen DAG and checkbox coverage. Runtime acceptance must use generated bundles with real engine operations, deterministic clocks/IDs and provider fakes for external calls. Cover successful and rejected transitions, authorization, tenant isolation, immutable history, retries, concurrency and restart. Provider acceptance fails on missing required infrastructure; local/emulated results remain distinct from live certification. Record commands, versions, dependency digests and each case result, including blockers. A schema compile or snapshot is insufficient proof of behavioral invariants.
