# Fulfillment

Fulfillment owns durable business execution observations. Domain requests point to FulfillmentSet and own payloads, quantities and business workflow. Each immutable Fulfillment pins an optional SpecificationPin and EvidenceSeal, executor handle, requested time and producer-assigned set ordinal. Executor is a fulfillment-specific identity handle; BobRunner and other typed domain satellites add identity details without introducing generic EntityRef.

Start and terminal facts are append-only and unique per fulfillment. `Fulfillments.status` reads terminal state first, then start, failing closed on unreadable facts. Completion/failure requires a matching start and valid timing; cancellation may precede start. Completed work declares complete or partial coverage; failed/cancelled work declares none. Typed outcome satellites contain actual business results, not generic JSON. The example LabOutcome records processed sample count; the domain must enforce its aggregate quantity policy across runs. Foundation does not infer a completed order from partial results.

Concurrent terminal reports admit one winner. A terminal observation is final; a later start observation can be retained but never reopens the business state. The `start` helper rejects an already-visible terminal fact, but raw observation ingestion and cancellation races can record late start facts. This is an observation model, not a promise that physical work cannot begin after cancellation. Stopping physical work is a separately authorized queue/worker operation.

Multiple fulfillments share a set. Replacement links preserve the prior terminal fact and require a higher ordinal in the same set, preventing cycles and cross-intent replacement. A replacement never erases prior outcomes. Partial versus replacement accounting stays in the domain. Worker retries are attempts of the same queue task; they do not create a new request or business fulfillment.

## WorkQueue bridge

`enqueueTask` authorizes the business fulfillment, persists an immutable queue/task link, then calls the real kernel WorkQueue with a requirements snapshot. Same task/input/requirements retries resume the existing task; conflicts fail. A failure between link persistence and enqueue leaves a resumable pending link. Queue and business storage are not falsely described as one transaction. Task cancellation/completion does not complete/cancel the business fulfillment. The caller must authenticate and authorize worker registration/claim operations as required by WorkQueue; this helper does not grant runner authority.

The consumer test derives requirements from the actual compiled consumer IR and pinned implementation/provider manifests, registers an eligible runner, enqueues, claims, fails/retries, fences a stale completion, invokes the typed DevelopmentWork function, then completes the task and explicitly records a domain outcome and business completion. A second task is independently cancelled. Queue and Engine use the same real memory/SQLite storage, including durable queue documents. No mock WorkQueue is used.

## Verification

```sh
pnpm --filter @forgegraph/capability-manifest run build
cargo run -q -p forgegraph-cli -- check packages/foundation/fulfillment/fixtures/consumer
cargo run -q -p forgegraph-cli -- build packages/foundation/fulfillment/fixtures/consumer --out /tmp/foundation-fulfillment-test
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-fulfillment-test pnpm --filter @forgegraph/runtime exec vitest run test/foundation-fulfillment.test.ts
```

Fixtures cover Bob development request/outcome, partial laboratory outcomes and replacement, and provisioning request/outcome. Tests exercise generated resources, imported specification/evidence contracts, actual WorkQueue, tenant isolation, invalid timing, terminal races, replacement cycles, retained history, authorization and restart. These are executable synthetic domain probes, not claims of deployment into the real Bob application. SQLite/D1-adapter evidence does not certify live D1, PostgreSQL or DynamoDB. Root integration owns exports, catalogs, generated consumer fixtures and evidence registration; contract acceptance remains planned until recorded.
