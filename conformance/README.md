# Conformance

Parity as an executable specification (plan §26). One scenario set, several
targets.

```
pnpm test                                   # scenarios vs the in-memory semantic model
FORGE_TARGET_URL=<base> FORGE_TARGET_NAME=<label> pnpm vitest run test/remote.test.ts
```

Remote runs go through the generated client (`fixtures/acme.client.ts`) —
the same code that application clients use — and write
`reports/<label>.json`.

## Certification (2026-09-20)

| target | deployment | scenarios | steps | failures |
| --- | --- | --- | --- | --- |
| runtime-memory | in-process | 15 | 221 | 0 |
| cloudflare-d1 | `https://forge-acme.<your-subdomain>.workers.dev` (Workers + D1 + R2 + Queues + Workflows + Cron Triggers + Durable Objects) | 15 | 221 | 0 |
| node-postgres | bundled `deploy/node` on Node 24 + PostgreSQL 17 (local, `pnpm node:serve`) | 15 | 221 | 0 |
| aws-dynamodb | `https://<api-id>.execute-api.<region>.amazonaws.com` (HTTP API + Lambda + DynamoDB + S3 + SQS + Step Functions + EventBridge + API Gateway WebSocket) | 15 | 221 | 0 |

M8 adds `limits` (10 logical mutations per atomic changeset with the preview
reporting the bound, page clamp, malformed cursors, length constraints, id
syntax, idempotency-key reuse), the live provider-switch test
(`test/switch.test.ts`), the benchmark (`pnpm bench`) and the certification
run (`pnpm certify` → `certification/latest.json`).

M7 adds the realtime profile (`test/realtime.test.ts`, run with
`FORGE_TARGET_URL` + `FORGE_TARGET_WS`): `OrderEvents` is bound with
`@websocket("/v1/live/orders")`. Publications reach the stream ledger through
the outbox (subscription `realtime:OrderEvents`), get a per-(tenant, stream)
sequence number and a bounded replay window (256), then fan out: a Durable
Object per (tenant, stream) with hibernating sockets on Cloudflare, an API
Gateway WebSocket API with a document-backed connection registry on AWS.
Verified live on both: subscribe → hello{latest}, ping/pong, an `OrderSubmitted`
event with `seq: 1` after a submit over HTTP, and a fresh connection resuming
by position (`resume after 0` → `resumed{replayed:1, gap:false}` + the frame),
unknown streams rejected. Frames are text JSON capped at 64 KiB; delivery is
at-least-once; connection identity is not preserved across reconnects — the
position is.

M7 adds `schedules`: `NightlyReconciliation` (`cron "0 3 * * *"`, UTC)
compiles to an explicit recurrence IR (sets, 0/7 = Sunday, day-of-month OR
day-of-week) and to each provider's trigger (exact Cloudflare Cron Trigger and
EventBridge `cron(0 3 * * ? *)`, or a periodic tick when a provider cannot
express the rule, e.g. dom-OR-dow on EventBridge or any non-UTC schedule on
Cloudflare). Occurrence identity is (schedule, intended instant): the scenario
ticks with controlled `now` values and verifies a late delivery runs the
intended 03:00 occurrence, a duplicate tick is a no-op, missed occurrences
catch up oldest-first within a 3-day window and older ones are recorded as
skipped, overlap policy `skip`. Local-time schedules are covered by DST
fixtures in `packages/runtime/test/schedules.test.ts` (spring-forward gap
skipped once, fall-back overlap fires once).

M7 adds `workflows`: `ProcessOrder` (submit → wait for PaymentCaptured
correlated by reference → short-payment choice → approve → parallel
summary/settle → return). The portable executor owns every step semantic; the
provider driver owns timers: Cloudflare Workflows (`step.sleep`,
`step.waitForEvent` bounded by the wait's deadline, woken by `sendEvent`) and
Step Functions Standard (Wait state, `waitForTaskToken` callback woken by
`SendTaskSuccess`). Verified live on both: idempotent start (one submit),
duplicate signals dedup by messageId, an early signal held in the inbox and
consumed when the waiter registers, a late signal after cancellation goes
nowhere, a declared callee error caught into a declared terminal, an
undeclared failure mapped to its code, cancellation that leaves completed
effects in place, and several drivers advancing one instance converging on a
single terminal outcome (CAS + reload-and-continue; activities are
exactly-once through storage receipts).

M6 adds `temporal-hierarchy` (half-open effective dating with guarded
overlap, cycle-safe hierarchy moves, bounded traversal) and
`views-projections-cache`: a view lowered to the source's bounded list plus
filter (a missing partition key is a validation error, never a scan); a
projection that is `ProjectionNotReady` until its first rebuild, then
maintains count and exact fixed-point sum from `Order.changes` through the
same outbox as every other subscription (contribution ledger keyed by source
id + revision, so stale or duplicate events never overwrite a newer
contribution and a cancellation subtracts); and a cache reader whose
`freshUntil = min(5m, next effective boundary)` and whose expired entries are
rejected on read before any physical cleanup. Projections and caches use the
existing document primitive, so no adapter grew a new storage shape.

M5 adds `messaging` (implemented SubmitOrder with declared dependencies,
domain errors, atomic transition + publication). Delivery was verified end to
end on both clouds: the outbox row for OrderSubmitted reaches the
`fulfill-order` queue (Cloudflare Queue / SQS) and the FulfillOrder consumer
runs exactly once (processed ledger).

M4 adds `blobs` (signed upload, verification, sealing, immutable download,
rejection; real bytes through R2 and S3) and `csv-import` (inspect, mapping,
upsert, in-file duplicates, per-row errors, commit through the changeset).
The generic workspace (`https://forge-acme-workspace.<your-subdomain>.workers.dev`,
`?api=<base>`) was driven in a headless browser against both APIs:
add row -> preview -> commit rendered the new record on each, with no
console errors.

D1 facades (`packages/runtime/test/d1-facades.test.ts`, real local D1 via
the harness Worker): raw-d1, drizzle, effect-sql each pass all 7 scenarios
(21/21). Drizzle's `batch()` only accepts its own query objects, so the
atomic batch is always the D1 binding's — a facade choice never changes
semantics.

M3 adds `integrity` (restrict-delete via dependents, hard delete, delete
racing child creates) and `changesets` (propose/preview/approve/commit,
atomic all-or-nothing with re-checked revisions, resumable per-row with
re-entrant commit).

Scenarios: `customer-crud` (create/read/patch/revisions/find/soft
delete/restore/claim retention), `site-references` (composite uniqueness
within a parent, reference guards, tenant isolation), `pagination`
(declared order, tie-breaker, opaque cursor, limit cap, invalid cursor),
`concurrency` (6-way same-version update race, 5-way unique-claim race —
exactly one winner each), `idempotency` (replay and mismatch).

## Scenario format

`scenarios/*.json`: ordered steps. A call step names an operation by stable
id, gives an input (with `$step.field` references and symbolic `$id:n`
placeholders), and expects either `ok` (a subset of the normalized result) or
`error` (a code). A race step fires N concurrent calls and asserts the count
of successes and the allowed failure codes — allowed histories, not a fixed
winner. Volatile fields (`createdAt`, `updatedAt`, `requestId`, `etag`) are
dropped before comparison; generated ids are normalized to `$id:n` in order
of first appearance.
