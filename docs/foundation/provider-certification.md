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
source change requires rerunning the profile. Dedicated hosted infrastructure is now provisioned; retained execution evidence is
listed in the verified checkpoint below.

## Full package invariant profiles

`--profile <slug>` runs the existing package invariant suite through the real
provider environment, with exact assertion titles declared in
`conformance/foundation/providers/profiles.json`. The default `core` remains the
five-trace probe. Expanded profiles cover Allocation (F34-05), Ledger (F36-06),
and Decision, Assurance, Change, Experiment, Agreement/Catalog, Adjudication,
Operations, Reconciliation, Integration, Publication, Collaboration and
Notifications (F39–F50 STORE). Each profile uses its actual consumer fixture.

```sh
node scripts/verify-foundation.mjs --suite providers --provider postgres \
  --profile integration --receipt-dir /tmp/foundation-provider-receipts
```

The provider Vitest configuration replaces only the local fixture helper. It
never substitutes memory/SQLite for database persistence and never skips tests.
Multiple test cases get unique tenants and provider transaction-token prefixes;
reconstructed engines retain the same clock and durable adapter. Artifact bytes
use a disclosed memory object store: these receipts certify database invariants,
not hosted object-storage durability. The agreement receipt-miss race runs on the
selected adapter as well. Reconciliation additionally builds its real controller
fixture; work queues and actor state use the selected database storage adapter.

A profile receipt identifies its criterion and every executed assertion, generated
bundle/migration hashes, source fingerprint and observed provider identity.
Fingerprinting includes runtime source, helpers, all runtime tests, package
closure, compiler, runner and profile manifest. It does not change acceptance
statuses. A criterion requires passing receipts for matching code on PostgreSQL,
hosted D1 and hosted DynamoDB; one profile does not certify other profiles.

D1 needs the selected profile's SQL schema and an authenticated worker advertising
that exact bundle hash. The existing core worker cannot certify another profile.
Provision a dedicated DB/Worker per profile, or review migrations and update the
identity before switching profiles. The runner never provisions or migrates D1.
DynamoDB uses the same adapter key layout for all profiles, with a unique run and
test tenant namespace, and performs no table schema mutation or remote cleanup.

All fourteen profiles have passed on all three providers at the checkpoints
recorded below. Any source change requires fresh matching receipts; core-only
receipts are insufficient.

## Aggregate acceptance evidence

After collecting final-source receipts for all profiles on all three providers:

```sh
node scripts/verify-foundation-certification.mjs \
  --receipt-dir /tmp/foundation-provider-receipts \
  --out /tmp/foundation-provider-certification.json
```

This gate rebuilds all consumer artifacts and requires all 42 cells. It validates
current source fingerprints, exact profile criteria/assertions, raw Vitest report
digests and skip/todo counts, observed provider identities, and D1 deployment
bundle/harness identity. Missing/stale evidence produces a failed aggregate and
nonzero exit. Passing evidence records the receipt/report hashes and source for
each cell; contracts remain unchanged. The aggregate is database-durability
acceptance evidence, not cryptographic provider attestation or object-storage
certification. Re-run it after code changes rather than reusing an old index.

Dedicated infrastructure provisioning is documented in `conformance/foundation/providers/README.md`; recorded test resource identifiers are in `docs/foundation/test-infrastructure.json`. The PostgreSQL Compose configuration validates, but this workstation has no running Docker daemon; executed PostgreSQL evidence uses the native PostgreSQL17 service.

## Verified implementation checkpoint

At `9c92db7bfa73dc1523bb1570f6ccd60c3ce684a0`, after integrating installable app adapters and reviewed migration composition, all 14 profiles passed on native PostgreSQL17, hosted Cloudflare D1 and hosted AWS DynamoDB. The aggregate gate rebuilt every bundle and accepted all 42 cells. `provider-evidence/certification.json` indexes the retained receipts and raw reports. The earlier checkpoint separately passed the five core traces on each provider. This satisfies the bounded database profiles for F34-05, F36-06 and F39–50 STORE. It does not certify hosted object bytes or deployed application adoption.

Contract files retain their original package-local status (`294/308` passing, 14 provider IDs planned); provider acceptance is established separately by the source-bound aggregate receipt. This avoids treating a local verifier as proof of hosted behavior or rewriting its input contracts after certification.

The earlier checkpoint aggregate is retained as `provider-evidence/certification-834dd37c.json`; it is historical evidence, not the current-source gate.

The previous implementation aggregate is retained as `provider-evidence/certification-f64c1b81.json`. The current refresh had one D1 Operations transport failure, followed by a passing full-profile run in a fresh tenant. Its failed receipt/raw report and `retry-notes-9c92db7b.md` are retained; the aggregate selects the passing retry and validates all 42 cells.
