# Foundation provider certification profile

`node scripts/verify-foundation.mjs --suite providers --provider postgres|d1|dynamodb|all`
executes the `foundation-core-invariants/1` profile. `--receipt-dir <directory>`
selects the report destination (default `conformance/reports/foundation/providers`).
This is a bounded provider probe, not blanket certification of every Foundation
package or satisfaction of all STORE criteria. No acceptance statuses are changed.

Five required traces execute against the selected real storage adapter:

- `capacity-race-and-restart`: competing exclusive Allocation bookings, recreated
  Engine/helper, release replay, one accepted release, restored capacity.
- `authorized-atomic-rollback`: unique conflict rolls back an entire Engine atomic
  group; denied atomic write leaves no record; cross-tenant get fails.
- `exact-ledger-reversal`: published balanced six-decimal posting, replay,
  micro-unit imbalance rejection and exact reversal through Ledger.
- `usage-retry-and-isolation`: concurrent duplicate Usage ingestion, mismatched
  replay rejection, exact aggregation and tenant isolation.

- `terminal-absence-guard-race`: existing terminal fact aborts publication;
  mutually exclusive absent-key transactions have one winner without leaked rows;
  the guard is tenant-scoped.

The dedicated Vitest configuration discovers these traces only. It does not reuse
optional `skipIf` adapter suites, local SQLite, memory storage, Dynamo Local or
Wrangler local D1. Every named trace must pass; skipped, todo, missing, duplicate or
additional assertions invalidate the receipt. Object/blob storage is not exercised.
The recreated Engine shares the deterministic test clock and real durable adapter;
it tests reconstruction, not OS process termination or network fault injection.

## PostgreSQL

Set `FORGE_FOUNDATION_PG_URL` to an authorized test database. The harness creates
one UUID-named schema, applies its generated migration, and drops only that schema
on close. Eight native pg connections allow genuine contention. Local PostgreSQL
is labeled `native-postgres-local`, never hosted D1/DynamoDB. Remote PostgreSQL is
labeled `native-postgres-remote`; the runner does not infer a cloud vendor.

```sh
FORGE_FOUNDATION_PG_URL=postgres://forge@127.0.0.1:55479/forge_foundation \
  node scripts/verify-foundation.mjs --suite providers --provider postgres
```

## Hosted D1

An operator must supply an existing dedicated test D1 database and deploy the
checked-in `conformance/foundation/providers/d1-worker.mjs` into an authorized
Cloudflare Workers account. The runner neither creates nor deploys infrastructure
and never applies remote migrations. This SQL bridge belongs only on a dedicated
test database; its bearer grants read/write SQL access and must not be shared with
application users or bound to a production database.

Before deployment, build the fixture locally:

```sh
cargo run -p forgegraph-cli -- build conformance/foundation/providers/fixture --out /tmp/foundation-provider-bundle
shasum -a 256 /tmp/foundation-provider-bundle/app.json
shasum -a 256 conformance/foundation/providers/d1-worker.mjs
```

Apply `/tmp/foundation-provider-bundle/d1/0001_init.sql` to the dedicated existing DB
using the operator's normal reviewed migration procedure. Configure Worker binding
`DB`, secret `CERT_TOKEN`, and variables `BUNDLE_SHA256` and `HARNESS_SHA256` with
the two digests. Deployment/provisioning approval is outside this runner.

Set `FORGE_FOUNDATION_D1_URL` to its HTTPS `*.workers.dev` origin and
`FORGE_FOUNDATION_D1_TOKEN` to the bearer secret. The runner checks authenticated
identity, the bundle and harness hashes, and Cloudflare request colo metadata.
The SQL executor forwards atomic batches to the actual `DB.batch` binding; it never
emulates transactions through separate HTTP calls. The identity is an operator
configured deployment assertion, not cryptographic infrastructure attestation.
Local URLs and redirects are rejected. Test tenant rows remain for inspection;
no automatic remote deletion or cleanup occurs. The authenticated SQL bridge does
permit data DELETE statements; it has no separate cleanup/provisioning endpoint.

## Hosted DynamoDB

Set `FORGE_FOUNDATION_DYNAMO_TABLE`, `AWS_REGION`, and normal AWS SDK credentials
(environment, approved profile or workload identity). Use an existing dedicated
Forge test table with string `PK`/`SK` keys and the normal Forge adapter indexes.
The harness uses DescribeTable to require an ACTIVE table, then runs DynamoStorage
against the explicitly selected AWS regional HTTPS endpoint. SDK endpoint overrides
are rejected. It never invokes ensureDynamoTable, CreateTable, UpdateTable, scans
for deletion or deletes a table. Test tenant rows remain for operator inspection.

Credentials need DescribeTable and the data/transaction permissions used by
DynamoStorage on this dedicated table. Missing credentials, denied access, missing
tables or incompatible schemas fail; they do not turn into skipped tests.

## Evidence and limitations

`--provider all` preflights configuration for every provider before building or
writing test data. It does not reuse a prior provider's receipt as another's proof.
A failed provider stops the run; earlier successful receipts remain individually
valid, but there is no implied all-provider success.

Each run writes a UUID-named receipt with selected provider/topology, hashed target
identity, observed server/deployment identity, test tenant prefix, source closure
fingerprint, generated bundle/migration hashes and required trace names. Successful
receipts bind the raw Vitest JSON report digest and passing names. Source mutation
during the run invalidates success. Failure receipts and produced test reports are
retained. Credentials and database URLs are not included in receipts. Reports are
execution evidence, not signed certificates or evidence of untested package cases.

Missing configuration fails before execution and creates no passing receipt. A
source change requires rerunning the profile. Hosted D1 and DynamoDB runs remain
pending until authorized test infrastructure and credentials are supplied.
