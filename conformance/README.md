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

## M2 certification (2026-09-20)

| target | deployment | scenarios | steps | failures |
| --- | --- | --- | --- | --- |
| runtime-memory | in-process | 5 | 48 | 0 |
| cloudflare-local | `wrangler dev` + local D1 | 5 | 48 | 0 |
| cloudflare-d1 | `https://forge-acme.gmac.workers.dev` (Workers + D1) | 5 | 48 | 0 |
| aws-dynamodb | `https://65geshs364.execute-api.us-east-1.amazonaws.com` (HTTP API + Lambda + DynamoDB) | 5 | 48 | 0 |

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
