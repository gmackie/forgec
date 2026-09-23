# Dedicated Foundation certification infrastructure

Provision only dedicated test resources. The provisioner creates a fresh DynamoDB table or a D1 database and authenticated Worker; it never adopts an existing database or deletes resources. Each D1 profile has its own compiled schema and Worker bundle identity. Credentials come from the AWS CLI profile or Wrangler login/environment, never from checked-in files.

```sh
node scripts/foundation-test-infra.mjs --provider dynamodb \
  --name forge-foundation-test-example --region us-east-1 \
  --state-dir /tmp/forge-foundation-dynamo-example
node scripts/foundation-test-infra.mjs --provider d1 --profile allocation \
  --name forge-foundation-test-allocation-example \
  --state-dir /tmp/forge-foundation-d1-allocation-example
```

The private state directory records resource identifiers, generated schemas, Worker config and an `infrastructure.json` receipt. D1's random bearer token is stored separately with mode0600 and supplied to Wrangler through stdin. Do not commit or publish the state directory. A failed provision retains its receipt and logs so resources can be recovered without guessing or provisioning duplicates. There is no automatic resource deletion.

Set the environment values from the receipt before running `node scripts/verify-foundation.mjs --suite providers --provider <provider> --profile <profile>`. For D1, additionally load `FORGE_FOUNDATION_D1_TOKEN` from `tokenFile` into the child process environment; never place it in command arguments or logs. `profiles.json` declares the exact required package assertions; `core` runs the five kernel composition traces. Missing credentials, wrong deployed artifact hashes, skipped assertions or source changes fail certification.

PostgreSQL requires `FORGE_FOUNDATION_PG_URL`; each fixture creates and drops an isolated UUID schema. Migration rehearsals use temporary SQLite databases and the same isolated PostgreSQL schemas. Run `pnpm --filter @forgegraph/runtime exec vitest run test/foundation-evaluation-quarantine.test.ts` to exercise fencing, legacy backfill quarantine, fresh evaluation and canonical import verification. No production snapshot is required for these synthetic migration rehearsals.

DynamoDB uses PK/SK and the sparse `pending-index`, on-demand billing, and the `purpose=foundation-certification` tag. Fixture-specific tenants isolate test records. Remote test tables retain records for inspection; resource removal is a separate explicit operator action. Blob uploads in package traces currently use a memory object store; database certification does not certify hosted object storage or production application deployment.

For a reproducible disposable PostgreSQL17 service:

```sh
docker compose -p forge-foundation-tests -f conformance/foundation/providers/compose.yaml up -d --wait
export FORGE_FOUNDATION_PG_URL=postgres://forge:foundation-test-only@127.0.0.1:55479/forge_foundation
```

The service binds loopback and uses an explicitly test-only password and temporary memory-backed data. Set `FORGE_FOUNDATION_PG_PORT` if the port is occupied, and match it in the URL. Stop the disposable service with the same Compose project/file and `down`. This is separate from hosted D1/DynamoDB resources.
