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
| runtime-memory | in-process | 12 | 167 | 0 |
| cloudflare-d1 | `https://forge-acme.gmac.workers.dev` (Workers + D1 + R2 + Queues) | 12 | 167 | 0 |
| aws-dynamodb | `https://65geshs364.execute-api.us-east-1.amazonaws.com` (HTTP API + Lambda + DynamoDB + S3 + SQS) | 12 | 167 | 0 |

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
The generic workspace (`https://forge-acme-workspace.gmac.workers.dev`,
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
