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
| runtime-memory | in-process | 9 | 106 | 0 |
| cloudflare-d1 | `https://forge-acme.gmac.workers.dev` (Workers + D1 + R2) | 9 | 106 | 0 |
| aws-dynamodb | `https://65geshs364.execute-api.us-east-1.amazonaws.com` (HTTP API + Lambda + DynamoDB + S3) | 9 | 106 | 0 |

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
