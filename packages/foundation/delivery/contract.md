# Delivery substrate contract

Experimental `@forgegraph/foundation/delivery` 0.1.0 implements #38, directly
composing Artifact and Evidence. Typed destination/content satellites represent
email, webhook and file-export cases without universal payload JSON.

Immutable consecutive DeliveryStep claims serialize send/retry/cancel choices
through unique intent+number. DeliveryAttempt is unique per Send step, receipts
are unique per step/attempt, and uncertain outcomes receive at most one definitive
resolution. Raw schema rules enforce predecessor and timing constraints, retry
limits and terminal uniqueness. No helper writes outside normal authorized Engine
operations. Artifact/evidence references pin immutable revisions/seals.

## Acceptance

All seven F38 criteria have local generated memory/SQLite evidence in
`packages/runtime/test/foundation-delivery.test.ts`. Four tests cover typed fixtures,
real artifact publication, sealed support, logical/callback idempotency, competing
numbering/cancellation, history, ambiguous provider result and reconciliation,
late callback rejection, tenant denial and hidden terminal facts.

```sh
target/debug/forgec build packages/foundation/delivery/fixtures/consumer --out /tmp/foundation-delivery-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-delivery-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-delivery.test.ts
```

Read README.md before implementing a provider adapter: timeout is not failed send,
provider execution occurs outside the database transaction, uncertain recovery may
remain unresolved, and neither claim idempotency nor callback deduplication promises
universal exactly-once delivery. No hosted-provider certification is claimed.
