# Usage

Usage is durable consumption, not telemetry, a ledger entry or an invoice. Domain entities point to UsageStream sidecars; no polymorphic subject pointer is stored. UsageDimension fixes an immutable domain key and exact unit. Each stream has one dimension; events validate both dimension and unit against their immutable references. Conversion/rating belongs above this package.

Quantities use `decimal<6>`: six fractional digits, strings on the wire, and the kernel's exact per-event minor-unit range. Greater precision is rejected. Aggregation sums BigInt minor units and formats an exact decimal, without floating-point rounding; aggregate totals can exceed one event's range.

## Ingestion and corrections

An event is either a point (`occurredAt`) or a nonempty half-open interval (`intervalStart`, `intervalEnd`). `(source, eventKey)` is a permanent tenant-scoped unique identity. `Usage.ingest` normalizes quantity/time, uses that source identity for receipt idempotency, reads successful replays through authorized Engine.get, and falls back to an authorized identity lookup if a row predates its receipt. Identical retries return the existing event; differing payloads fail. Streams also require a unique producer-assigned positive ordinal. Producers coordinate ordinal allocation; this package does not allocate sequence numbers.

To correct a measurement, ingest a new event with `replacementFor` pointing to the old event and a higher stream ordinal, then call `correct(old, replacement, reason)`. The staged replacement contributes nothing until the terminal link is committed. At most one immutable UsageCorrection exists for each original event; a null replacement retracts it. Concurrent correction/retraction admits one winner. Same-stream/dimension and forward-ordinal constraints prevent cycles. Original measurements are never mutated. A losing staged replacement remains inspectable but is not counted. Further correction points to the replacement event. Retraction is terminal; reinstatement is an explicitly new source event, not an erased retraction.

This staged protocol avoids a dependency on atomic creation of multiple related records. A crash before linking leaves the old value authoritative; a retry can resume linking the already-ingested replacement. The source identity and caller idempotency keys remain distinct contracts: correction/retraction retries may use an explicit context idempotencyKey.

## Aggregation and replay

`Usage.aggregate(stream, from, until)` walks original events and resolves each correction chain once, then includes active points in `[from, until)` and intervals wholly contained in that range. An overlapping partial interval fails instead of inventing proportional consumption. Corrections can amend quantities or time windows. Chains are bounded to 128 and scans to 10,000 events, failing explicitly at the bound.

Internal bounded storage enumeration detects every event; all rows and all encountered terminal facts are subsequently read through authorized Engine surfaces. An unreadable correction/retraction is never interpreted as absent, and filtered list results cannot silently lower a total. A stream must also be readable. Enumeration order is deterministic by ordinal and all pages are exhausted.

The returned projection contains the exact contributing immutable event IDs, dimension/unit and bounds. `replay` re-authorizes these facts and recomputes their sum, retaining the original observed interpretation after later corrections. It does not reapply current corrections. The returned manifest is a derived value, not a signed authoritative certificate. Live aggregation is a bounded observation, **not a cross-row transactional snapshot**; concurrent ingestion/correction may be observed at different instants. Preserve its event-ID manifest when reproducibility matters. Issuing billing/ledger commitments against a consistent watermark requires an upper-layer closure protocol.

## Verification

```sh
cargo run -q -p forgegraph-cli -- check packages/foundation/usage/fixtures/consumer
cargo run -q -p forgegraph-cli -- build packages/foundation/usage/fixtures/consumer --out /tmp/foundation-usage-test
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-usage-test pnpm --filter @forgegraph/runtime exec vitest run test/foundation-usage.test.ts
```

Generated consumer resources cover LlmSession, ComputeRun and MachineRun. The memory and transactional SQLite/D1-adapter tests cover exact sums, pagination, duplicate races and conflicts, invalid dimensions/units/precision, temporal boundaries, staged corrections, competing retractions, immutable history, correction cycles, authorization failure, tenant isolation and replay after restart. Live D1/PostgreSQL/DynamoDB certification remains separate. The root integrator owns generated fixture refresh, helper export and verifier registration. Contract acceptance remains planned until evidence is registered.
