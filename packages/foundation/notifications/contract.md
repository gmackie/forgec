# notifications contract

Phase 0 design contract for [issue #50](https://github.com/gmackie/forgec/issues/50), under epic #25. This freezes the proposed package boundary for implementation; it does not provide executable schemas or claim any passing acceptance. `contract.json` is the machine-readable ownership/dependency/acceptance catalog. Every source issue checkbox has a corresponding `F50-NN` entry in source order.

## Ownership and dependencies

Forge identity: `@forgegraph/foundation/notifications`. Hard package dependencies: `participation`, `delivery`, `artifact`. Package-qualified identities remain stable when composed into a selected application storage closure. Required compiler, pattern and kernel contracts are prerequisites outside this slug-only dependency list.

Owned facts:

- NotificationTopic.
- NotificationSubscription.
- NotificationPreference.
- NotificationEndpointLink.
- Notification.
- NotificationDeliveryLink.
- NotificationSuppression.

Commands:

- Subscribe.
- Set preference.
- Resolve audience.
- Create logical notification.
- Record suppression.
- Request delivery.
- Observe delivery outcome.

These are behavioral operation contracts, not claims that function names or Forge syntax are already implemented. Reads expose bounded, tenant-scoped typed lookups and history. Implementation must define exact input/output/error shapes before its code is accepted.

## Typed composition seams

Typed event/content satellites reference Notification; Artifact holds immutable template/content revisions. Endpoint references use typed contracts and kernel-governed secrets; provider delivery calls remain implementation capabilities. Collaboration joins only in application wrappers.

Typed resource references must resolve within the explicit selected package closure; remote calls retain normal imported callable contracts. No targetType/targetId, generic EntityRef, tagged-union domain hierarchy or universal JSON business payload is admitted. Domain terminology may wrap these names freely. Lower packages never import this system.

## Lifecycle and policy

Notification is pending, suppressed, dispatched or completed/failed according to linked delivery result. Evaluate preference policy before dispatch and record its revision; policy defines whether later changes cancel pending intent. Delivery retries never create a new logical notification.

The lifecycle above describes required semantic distinctions and explicit policy choices; field names and transition syntax remain implementation details. Stateless waiting, retries, deadlines and orchestration compose through std patterns; durable responses, attempts and outcomes remain owned resources. Immutable specification/artifact references use exact revisions, never floating branches or channel aliases.

## Invariants, authorization and failure

- Notifications owns audience and preference semantics.
- Delivery owns attempts and receipts.
- Logical notification identity deduplicates repeated triggering events.
- Suppression decisions are durable and explainable.
- Templates remain independent of any mandatory templating language.

- Every mutation checks the caller's declared capability, tenant and resource authorization. Participation or entitlement membership alone does not grant kernel authorization; denied references must not leak foreign data.
- A logical command carries a stable idempotency identity scoped to tenant, operation and aggregate. Reusing it with different inputs fails with a typed conflict; successful retry returns the existing outcome.
- Validation and state transition commit under an aggregate/version guard. A stale version produces an explicit conflict; multi-resource invariants either commit atomically within provider bounds or use an explicit durable pending protocol. No read-then-write safety assumption.
- Invalid transitions, unresolved references, expired validity, stale revisions and provider failures have typed errors. External uncertainty remains recorded as pending/unknown rather than asserted success. Retry does not delete failure history.
- No generic CRUD mutation may bypass command invariants. History retention, redaction and correction policy must distinguish immutable business facts from mutable projections.

## Acceptance and fixture design

Each source checkbox is retained verbatim below. IDs are stable; implementation records evidence separately rather than changing planned status without a real run.

- `F50-01` (compile, planned): topic/subscription model.
- `F50-02` (compile, planned): preference model.
- `F50-03` (compile, planned): endpoint abstraction.
- `F50-04` (runtime, planned): notification lifecycle.
- `F50-05` (compile, planned): Delivery integration.
- `F50-06` (runtime, planned): dedup/suppression semantics.
- `F50-07` (fixture, planned): fixtures for KanBanger user notification, ForgeGraph operational alert and Bob task/update notification.
- `F50-R01` (concurrency, planned): Duplicate event resolves to one logical notification.
- `F50-R02` (concurrency, planned): Preference change and dispatch race obeys recorded policy.
- `F50-AUTH` (runtime, planned): Reject unauthorized and cross-tenant commands and references through generated runtime surfaces.
- `F50-STORE` (provider, planned): Run relevant durable invariant traces on PostgreSQL, D1 and DynamoDB with explicit evidence and no hidden required-suite skips.

Fixtures:

- KanBanger user notification: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- ForgeGraph operational alert: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.
- Bob task/update notification: typed domain wrapper, seeded happy path, invalid transition or authorization case, and retained-history assertions.

Application-named fixtures must record the inspected application repository revision and map real types/operations before being described as dogfooding. Synthetic cases establish only contract usability. Tests build actual imported consumer schemas, then exercise generated runtime surfaces; helper mocks and schema snapshots alone do not prove durable behavior. The independent handoff includes accepted dependency digests, compiler/runtime versions, exact commands, case results and provider configuration. Missing provider infrastructure is explicitly blocked evidence, never a silently passing skip.
