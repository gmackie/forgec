# Foundation implementation verification

The expanded scope contains41 packages and308 acceptance IDs. Each implemented package has a `verification.json` descriptor, typed generated consumer, runtime helper and focused behavior tests. Status is per criterion in `contract.json`; provider requirements remain pending. Package READMEs/contract implementation sections document bounded profiles and durable pending protocols.

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

Known cross-package limits include general transaction-local references/read overlays, serializable absence checks for Routing eligibility, hosted-provider certification and application dogfood. See `kernel-gaps.md` and package documentation. The Party identity migration is documented separately.

Plan: https://syhczsdoad8z.postplan.dev
Draft: https://github.com/gmackie/forgec/pull/70

EvaluationStart now records server-owned creation timestamps. Qualification/binding checks require finite, strictly earlier durable creation times, never caller-supplied startedAt. Equal or missing timestamps cannot establish order. Existing rows need an explicit migration; reconstructing or backfilling timestamps does not establish historical pre-execution binding, so ambiguous legacy evaluations require new evidence.

Remaining release gates are tracked in https://github.com/gmackie/forgec/issues/71; existing package acceptance IDs stay open where those gates apply.
