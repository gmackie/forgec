# Deployment

The `.forge` package, the generated bundle and the `impl/` sources are shared.
Only `deploy/<provider>/` differs. Reference files: `examples/acme/deploy`.

## Cloudflare (Workers + D1 + R2 + Queues + Workflows + Durable Objects + Cron Triggers)

`deploy/cloudflare/worker.ts`:

```ts
export default createWorker(bundle, { functions, externals });
export class ProcessOrderWorkflow extends createWorkflowEntrypoint(WorkflowEntrypoint, bundle, options) {}
export class ForgeRealtime extends createRealtimeObject(DurableObject, bundle, options) {}
```

`wrangler.jsonc` binds: `DB` (D1), `BLOBS` (R2), one queue producer per
subscription (`Q_<SUBSCRIPTION>` from `bundle.messaging`), one Workflows binding
per workflow (`bundle.workflows[].cloudflare`), the `REALTIME` Durable Object,
cron triggers (`*/5 * * * *` sweep plus `bundle.schedules.cloudflareCrons`),
and vars `FORGE_AUTH`, `FORGE_CORS`, secret `CURSOR_SECRET`.

Migrations: `pnpm cf:migrate:remote` applies `migrations/d1/*` (reviewed,
source-controlled; `conformance/test/migrations.test.ts` fails when the
generated baseline drifts). Deploy: `pnpm cf:deploy`.

## AWS (CDK: HTTP API + Lambda + DynamoDB + S3 + SQS + Step Functions + EventBridge + API Gateway WebSocket)

`deploy/aws/app.ts` is a plain CDK app: `TableV2` with the sparse
`pending-index`, an S3 bucket, one SQS queue (+ DLQ) per subscription, one
Standard state machine per workflow (definition from `bundle.workflows[].aws`),
EventBridge rules / Scheduler per schedule (`bundle.schedules[].aws`), a
WebSocket API, and one Lambda (`deploy/aws/handler.ts` → `createLambdaHandler`)
with `FORGE_TABLE`, `FORGE_BUCKET`, `FORGE_QUEUES`, `FORGE_WORKFLOWS`,
`FORGE_WS_ENDPOINT`, `FORGE_AUTH`, `FORGE_CORS`, `CURSOR_SECRET`.
`pnpm aws:deploy` bundles with esbuild and deploys; outputs `ApiUrl` and
`RealtimeUrl`. DynamoDB needs no DDL for field changes; its key plan is in the
bundle.

## Node + PostgreSQL (self-hosted)

`deploy/node/server.ts` composes the same runtime with `createPostgresStorage`
and `createNodeHost` (Fetch ingress, WebSocket realtime, durable sweep loop,
`/healthz` and `/readyz`, graceful drain, a directory-backed object store
served through signed URLs). `pnpm pg:migrate` applies
`migrations/postgres/0001_init.sql` (the reviewed PostgreSQL baseline: 64-bit
exact numerics, `COLLATE "C"` text so ordering matches D1/DynamoDB);
`pnpm node:serve` bundles with esbuild and runs `deploy/node/dist/server.mjs`.
Environment: `FORGE_PG_URL`, `CURSOR_SECRET`, `PORT`, `FORGE_OBJECTS_DIR`,
`FORGE_PUBLIC_URL`, `FORGE_CORS`, `FORGE_TELEMETRY=json|emf|silent`.
Guarded batches run as `SERIALIZABLE` transactions; serialization failures are
retried by the engine as transient conflicts.

## Phased rollout (plan §21)

1. provision additive infrastructure;
2. apply compatible schema changes (`forge compat old.app.json new.app.json`
   must not report `breaking`);
3. deploy readers/writers that understand both shapes;
4. run backfills (never inside a stack custom resource);
5. switch traffic; validate; clean up.

Authoritative data is retained by default (`RemovalPolicy.RETAIN`, no
destructive D1 migrations without review).

## Secrets and auth

Bindings and secrets never enter the bundle. `FORGE_AUTH=dev-headers` is for
development only; supply an `AuthHost` (`authenticate(req) → Principal`) for
production. WebSocket upgrades carry auth in the query string (`?token=`),
which `upgradeAuthRequest` lifts into headers for the same host.
