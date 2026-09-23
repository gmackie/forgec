# Foundation implementation verification

The expanded scope contains41 packages and308 acceptance IDs. Each implemented package has a `verification.json` descriptor, typed generated consumer, runtime helper and focused behavior tests. Status is per criterion in `contract.json`; provider requirements are recorded separately in the source-bound 42-cell certification receipt. Package READMEs/contract implementation sections document bounded profiles and durable pending protocols.

Run:

```sh
pnpm foundation:contracts
pnpm foundation:composition
pnpm foundation:local
node scripts/verify-foundation.mjs --suite local --package scheduling
```

`foundation:local` runs every package in dependency order and fails if any descriptor is absent. Each package/consumer builds twice and all eight generated artifacts are compared. Reconciliation also builds its separate actor-preview controller twice. Tests consume those fresh bundles, not mocked helpers. Source-fingerprinted receipts are written under ignored `conformance/reports/foundation/`.

Set `FORGE_FOUNDATION_PG_URL` to a test PostgreSQL database to add isolated UUID schemas per test. Memory and SQLite always run. CI supplies PostgreSQL17. Hosted D1 and DynamoDB require separate credentials/infrastructure; provider mode explicitly fails instead of returning a false pass. Existing unrelated infrastructure suites may skip and their skips do not count as Foundation acceptance.

All 41 implementations are now integrated and independently tested in their supported local profiles. Full-suite results and the exact pushed checkpoint are recorded in the PR; source-fingerprinted receipts remain the per-package execution evidence. The earlier 38-package checkpoint58bcc7c6086a passed480 runtime,155 Rust and13 harness tests.

Synthetic application/domain consumers establish typed composition usability, not real-application adoption. `application-provenance.md` maps inspected application revisions and actual types to those probes. Append-only candidate rows are often inert until a validated publication journal/seal; use the package helper's authoritative read API. Admission/authority facts must be protected by normal kernel policies. The runtime cannot infer application user identity or permissions from Participation membership.

Known cross-package limits include general transaction-local references/read overlays, complete hosted-provider certification and deployed application adoption. Routing eligibility now uses serializable absence guards. See `kernel-gaps.md` and package documentation. The Party identity migration is documented separately.

Plan: https://syhczsdoad8z.postplan.dev
Draft: https://github.com/gmackie/forgec/pull/70

EvaluationStart now records server-owned creation timestamps. Qualification/binding checks require finite, strictly earlier durable creation times, never caller-supplied startedAt. Equal or missing timestamps cannot establish order. Existing rows need an explicit migration; reconstructing or backfilling timestamps does not establish historical pre-execution binding, so ambiguous legacy evaluations require new evidence.

Remaining release gates are tracked in https://github.com/gmackie/forgec/issues/71; existing package acceptance IDs stay open where those gates apply.

## Real-application verification

`pnpm foundation:apps` verifies six opt-in application adapters against pinned source files from real local application checkouts. Set the `FORGE_FOUNDATION_<APP>_ROOT` variables documented in each `examples/foundation/apps/<app>/verification.json`, plus `FORGE_FOUNDATION_PG_URL` for PostgreSQL coverage. The runner rejects missing source, stale digests, skipped required assertions and nondeterministic compiler artifacts. Receipts bind application source, generated artifacts and test results. These traces exercise actual application seams in an isolated harness; they do not establish production deployment or adoption.

Evaluation quarantine is a fenced migration boundary. Read historical runs through `Evaluations.phase` and raw records; use `Evaluations.result` for authority. A legacy result with a quarantine fact must be reevaluated with fresh bindings. `scripts/prepare-evaluation-migration.mjs` prepares a verified canonical export for isolated import rehearsal, preserving historical facts and adding quarantine records. The target stays fenced until import and verification complete. This mechanism does not provide concurrent live revocation of already admitted work.

The implementation checkpoint `834dd37cd758` passes all 41 package verifiers, 571 runtime tests, 155 Rust tests, 50 harness tests and 24 actual app assertions. Hosted database certification passes all 42 cells; retained evidence is in `provider-evidence/certification.json`. The first Node24 CI attempt exposed a pre-existing workflow idempotency race, tracked separately; do not interpret a retry as proof that race is fixed.
