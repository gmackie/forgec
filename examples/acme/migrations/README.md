# Migrations

Reviewed, source-controlled migration streams for the Acme deployment (plan §22).
`forge build` writes the current baseline schema to `generated/d1/0001_init.sql`;
`0001_init.sql` here is the reviewed copy of the baseline the deployment was created
from, and every later file is an additive change reviewed with the language change
that required it. `conformance/test/migrations.test.ts` fails when the generated
baseline drifts from the reviewed one, so a schema change cannot ship without a
migration. DynamoDB needs no DDL for these changes (attributes are added per item);
its key/index plan lives in the bundle.

Only wrangler applies the D1 stream (`pnpm cf:migrate:remote`); the execution ledger
is D1's `d1_migrations` table.
