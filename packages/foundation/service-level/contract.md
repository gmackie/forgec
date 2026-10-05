# Service Level Management

Implements issue #63 over Agreement/Catalog, Entitlement, Evaluation, Fulfillment, Availability and Specification. ServiceLevelPolicy pins its specification and UTC or Business clock; ServiceLevelObjective names a 1–44,640 minute target and warning threshold. Business policies require an exact AvailabilityCalendarRevision, including its timezone data version. Synthetic SupportFirstResponse, LabTurnaround and DeploymentObjective wrappers demonstrate all three requested domains.

## Start and clocks

`ServiceLevels.start` pins objective, accepted/issued Agreement right, underlying Entitlement and known EntitlementEnd, tracked Fulfillment and start/horizon instants. Agreement-aware rights must be effective at start, and already terminal fulfillments cannot be newly tracked. Later revocations/suspension do not silently cancel an existing contractual service commitment. The captured entitlement history is a knowledge snapshot, not a claim that later backdated facts were known earlier.

All clock instants are whole UTC minutes. Each instance has an immutable positive horizon of at most 31 days; queries outside it fail explicitly. UTC counts every elapsed minute. Business expands the exact Availability revision into effective windows and counts only available minutes, excluding recorded pauses. Calendar exceptions, timezone/DST semantics and digest/version validation remain owned by Availability. This implementation actually exercises business-hour windows; it does not label UTC-only arithmetic as calendar support.

`pause` and `resume` append events with nondecreasing effective instants to one bounded journal (64 events). Unique `(instance, ordinal)` and previous-event claims serialize races. Duplicate pause, resume without pause and transitions after a recorded terminal fulfillment fail. Late commands that try to insert before later known events conflict; history is not rewritten. Querying historical time includes events through that time only.

`state(instance, at, context)` reports elapsed minutes, projected dueAt, pause state and observed verdict. dueAt is null during an open pause or when the remaining pinned horizon contains insufficient available minutes. It is a bounded projection under recorded pauses, not a promise about future calendar changes. Target equality is still on time; elapsed strictly beyond target breaches. Complete successful fulfillment within target is Met. Failed/cancelled/partial terminal fulfillment breaches the objective.

## Durable assessments and remedies

A computed UI verdict alone is not a durable breach. `assess(instance, at, EvaluationFinish, context)` records a ServiceLevelEvent referencing a completed evaluation under the pinned policy definition and the then-observed terminal FulfillmentEnd, if any. Each EvaluationFinish may support only one assessment. The helper independently recomputes clock arithmetic; raw conflicting assessments fail validated replay. Evaluation execution/verdict provenance remains the trusted evaluator's responsibility; callers may not reuse a generic completed run as external proof without application policy.

`breach(instance, at, context)` materializes the first recorded Breached assessment as one unique ServiceLevelBreach, using a stable receipt. Concurrent retries cannot create duplicate breach facts. The journal itself retains breach evidence if materialization is interrupted. Once recorded, a breach remains recorded even when a later completion report claims an earlier on-time completion. That late fact is retained in the next assessment; it does not silently erase contractual breach history. A terminal assessment stops future clock events.

`remedy(breach, {obligation?, fulfillment?}, context)` links an explicit existing Obligation and/or Fulfillment to an authoritative breach. One unique receipt-backed remedy prevents duplicates and changed-input retries conflict. This package does not issue money, send notifications, assert remedy completion or cancel independent duties. Applications own credit/notification adapters and domain remedy selection.

## Authority and limits

All reads/writes use normal Engine.call. Hidden existing journal facts fail closed, rather than appearing absent. Independent Gatekeeper policy must authorize actors; agreement or entitlement membership is not authentication. Only helper-validated assessments/breaches are authoritative. Raw invalid journal rows can make an instance uninterpretable; restrict raw mutation rights accordingly. No cross-resource transaction or live external clock guarantee is claimed. Fulfillment timestamps are business observations, not cryptographic proof of execution time.

The fixed model measures a duration objective and complete success, not arbitrary error-budget formulas or percentile aggregates. New policy revisions create new objectives/instances; published policy fields never mutate. The 31-day/64-event bounds and minute precision are explicit first-version constraints.

## Verification

Nine generated tests pass on memory, SQLite and isolated local PostgreSQL 17: real Agreement acceptance/issued right integration, UTC pauses and due dates, Availability office hours crossing days, on-time fulfillment, durable breach races, late completion preserving breach, remedy retries, all three typed domain wrappers, hidden pause history, denied assessments and cross-tenant access. Runtime typecheck, Forge formatting and deterministic repeat consumer builds pass.

```sh
pnpm --filter @forgegraph/capability-manifest build
cargo run -q -p forgegraph-cli -- build packages/foundation/service-level/fixtures/consumer --out /tmp/forge-service-level-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/forge-service-level-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-service-level.test.ts
# FORGE_FOUNDATION_PG_URL adds isolated PostgreSQL traces.
pnpm --filter @forgegraph/runtime typecheck
```

The capability-manifest build is needed by the imported Fulfillments runtime helper. Live D1 and DynamoDB are unverified; local evidence supports development composition, not complete provider certification. Fixtures are synthetic examples, not application dogfooding.
