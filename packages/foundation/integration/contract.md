# integration contract

Phase 0 design contract for [issue #47](https://github.com/gmackie/forgec/issues/47), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F47-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/integration`. Hard package dependencies: `reconciliation`, `identifiers`, `delivery`, `fulfillment`, `lineage`, `evidence`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- Connection.
- ExternalMapping.
- SyncCursor.
- SyncRun.
- WebhookReceipt.
- SyncConflict.

Commands:

- Register connection.
- Bind qualified identifier.
- Receive webhook.
- Start sync run.
- Apply accepted records.
- Advance checkpoint.
- Resolve conflict.
- Record outbound delivery.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Domain-owned typed external record satellites reference mapping or sync run; no arbitrary external payload store. Provider adapters live in impl capabilities. IdentifierSet owns qualified identifier values. SyncConflict links to Reconciliation drift through typed resources.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Connections are configured, active, suspended or disabled. Runs are pending, running, succeeded, failed or cancelled; conflicts remain unresolved until an explicit authority decision. Checkpoints are monotonic under a provider-defined cursor ordering contract, or opaque with compare-and-set version fencing.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Credentials stay in kernel secret or credential contracts.
- Internal resources retain canonical Forge identity.
- Sync direction and authority are explicit per connection or mapping policy.
- Checkpoint cannot advance beyond durably accepted work.
- Duplicate provider events share a logical receipt identity.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F47-01` (compile, planned): Connection/provider metadata model.
- `F47-02` (compile, planned): external mapping model based on qualified identifiers.
- `F47-03` (runtime, planned): durable cursor/checkpoint.
- `F47-04` (compile, planned): SyncRun/fulfillment envelope.
- `F47-05` (runtime, planned): webhook receipt/dedup.
- `F47-06` (compile, planned): reconciliation/conflict hooks.
- `F47-07` (fixture, planned): fixtures for GitHub, Linear-style issue sync and one industrial/provider integration.
- `F47-R01` (concurrency, planned): Crash around checkpoint commit cannot lose accepted work or skip records.
- `F47-R02` (concurrency, planned): Duplicate webhook and concurrent cursor advance are idempotent and fenced.
- `F47-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F47-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- GitHub integration: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- Linear-style issue sync: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- industrial provider integration: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
