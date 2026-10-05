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

## Configured local setup and Forgejo job

The 2026-09-30 setup uses AWS account `637291210764` in `us-east-1`, Cloudflare
account `c07a7e704db1808e1fff91bed2b1cd49`, and a native Homebrew PostgreSQL17
instance on loopback port 55480. All resources are test-only. The native instance
replaces the initial Compose service after the local Docker VM became unavailable.
The DynamoDB table is `forge-foundation-test-20260930`; the core D1 database is
`forge-foundation-test-core-20260930`. Older test resources are untouched.

Private setup state lives at `~/.local/state/forgegraph/providers/20260930/`.
`setup.json` references the AWS CLI `default` profile, the PostgreSQL URL file,
and each provider's infrastructure receipt. Wrangler's local OAuth login is the
provisioning credential; each D1 harness has a separate random bearer token.
Run without exporting or printing tokens:

```sh
node scripts/run-foundation-providers.mjs \
  --state-dir "$HOME/.local/state/forgegraph/providers/20260930" \
  --provider all --profile core
```

The runner verifies private ownership/permissions, requires ready test receipts,
and loads credentials only into the verifier's environment. It rejects ambient
AWS static credentials when using a named profile and refuses endpoint overrides.
`--profile all` requires a separate D1 deployment for every profile in profiles.json;
it preflights all requested state before running. Core and all 16 package profiles are provisioned by
the 2026-09-30 setup. Source-bound receipts are written inside the state directory.

Forgejo configuration is `.forgejo/workflows/provider-certification.yml` in
`https://git.forgegraf.com/gmackie/forge`. It uses the existing `hetzner-bob`
instance runner through `[forgegraph-ci, heavy]`, a per-job PostgreSQL service,
and hosted D1/DynamoDB. It runs manually and weekly on Monday at 05:17 UTC.
The branch trigger exists to verify setup before merging. Secrets are scoped to
this repository: `FOUNDATION_AWS_ACCESS_KEY_ID`, `FOUNDATION_AWS_SECRET_ACCESS_KEY`,
and `FOUNDATION_D1_PROFILES` (a JSON map from profile to harness URL/token).
`FOUNDATION_D1_TOKEN` remains available for the original core-only job. The dedicated IAM user
`forge-foundation-certification-20260930` can read/write only this table and its
indexes; it cannot provision infrastructure. CI does not receive the personal AWS
profile or Wrangler OAuth credential.

The certification job runs core and all 16 package profiles on each provider,
then rebuilds artifacts and validates all 48 package receipts with
`verify-foundation-certification.mjs`. It publishes receipts and raw test reports
as the `foundation-provider-certification` artifact. D1's bundle identity is pinned: a schema/compiler change can intentionally
fail the job until a newly built dedicated harness is deployed and its URL/token
references updated. Neither this workflow nor the local runner deletes cloud
resources. Rotate the dedicated IAM key and D1 bearer token through their Forgejo
secret references. Database receipts do not certify hosted object storage.

### Local PostgreSQL lifecycle and verification evidence

The configured native instance keeps its data and random password in the private
state directory. Its URL is in `postgres-url`; the runner reads it without
printing it. It is currently running, but is not registered as a login service.
Use the versioned PostgreSQL17 binaries (the unqualified local binaries may be
PostgreSQL14):

```sh
provider_state="$HOME/.local/state/forgegraph/providers/20260930"
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D "$provider_state/postgres-data" status
# Start after a reboot or an explicit stop:
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D "$provider_state/postgres-data" \
  -l "$provider_state/postgres-server.log" -o '-h 127.0.0.1 -p 55480' -w start
# Stop when finished, retaining test data:
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D "$provider_state/postgres-data" -m fast -w stop
```

On 2026-09-30, all five core traces passed on each of native PostgreSQL17,
hosted Cloudflare D1 and hosted AWS DynamoDB, with passing local receipts.
[Forgejo run 29](https://git.forgegraf.com/gmackie/forge/actions/runs/29)
also succeeded on `hetzner-bob`, including the 17 setup tooling tests and the
three-provider core verification. This establishes the initial core setup;
the package matrix is checked separately as described below.

### Full package certification

Each package has private deployment state in `d1-<profile>/`, referenced by
`setup.json`. PostgreSQL uses isolated schemas and DynamoDB uses per-run tenants
on the existing dedicated test table. Run and aggregate the complete matrix:

```sh
provider_state="$HOME/.local/state/forgegraph/providers/20260930"
node scripts/run-foundation-providers.mjs --state-dir "$provider_state" \
  --provider all --profile all
node scripts/verify-foundation-certification.mjs \
  --receipt-dir "$provider_state/receipts" --out "$provider_state/certification.json"
```

The aggregate accepts exactly 16 profiles × 3 providers. Every receipt must match
the current source fingerprint, rebuilt artifacts, exact required trace set,
raw test report digest, and observed provider identity. Missing, skipped, failed,
or stale cells prevent certification. The Forgejo job uses the same verifier and
aggregate check, with a 120-minute timeout and serialized workflow runs. Up to
three profiles execute concurrently within a job; each profile uses its own D1
deployment, isolated PostgreSQL schema and per-run DynamoDB tenant.

When rotating a package harness, update its private infrastructure receipt and
the corresponding `FOUNDATION_D1_PROFILES` JSON entry in Forgejo. The secret has
entries shaped as `"<profile>": {"url": "https://…workers.dev", "token": "…"}`
for `core` and every profile in `profiles.json`. Credential values must never be
committed. Provisioning and resource deletion remain explicit operator actions.
