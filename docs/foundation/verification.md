# Foundation implementation verification

The expanded scope contains 41 packages and 308 acceptance IDs. Each implemented package has a `verification.json` descriptor, typed generated consumer, runtime helper and focused behavior tests. Status is per criterion in `contract.json`; provider requirements are recorded separately in the source-bound 42-cell certification receipt. Package READMEs/contract implementation sections document bounded profiles and durable pending protocols.

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

Known cross-package limits include general transaction-local references/read overlays and deployed application adoption. Routing eligibility now uses serializable absence guards. See `kernel-gaps.md` and package documentation. The Party identity migration is documented separately.

Plan: https://syhczsdoad8z.postplan.dev
Draft: https://github.com/gmackie/forgec/pull/70

EvaluationStart now records server-owned creation timestamps. Qualification/binding checks require finite, strictly earlier durable creation times, never caller-supplied startedAt. Equal or missing timestamps cannot establish order. Existing rows need an explicit migration; reconstructing or backfilling timestamps does not establish historical pre-execution binding, so ambiguous legacy evaluations require new evidence.

Remaining release gates are tracked in https://github.com/gmackie/forgec/issues/71; existing package acceptance IDs stay open where those gates apply.

## Real-application verification

`pnpm foundation:apps` verifies six opt-in application adapters against pinned source files from real local application checkouts. Set the `FORGE_FOUNDATION_<APP>_ROOT` variables documented in each `examples/foundation/apps/<app>/verification.json`, plus `FORGE_FOUNDATION_PG_URL` for PostgreSQL coverage. The runner rejects missing source, stale digests, skipped required assertions and nondeterministic compiler artifacts. Receipts bind application source, generated artifacts and test results. These traces exercise actual application seams in an isolated harness; they do not establish production deployment or adoption.

Evaluation quarantine is a fenced migration boundary. Read historical runs through `Evaluations.phase` and raw records; use `Evaluations.result` for authority. A legacy result with a quarantine fact must be reevaluated with fresh bindings. `scripts/prepare-evaluation-migration.mjs` prepares a verified canonical export for isolated import rehearsal, preserving historical facts and adding quarantine records. The target stays fenced until import and verification complete. This mechanism does not provide concurrent live revocation of already admitted work.

The implementation checkpoint `9c92db7bfa73dc1523bb1570f6ccd60c3ce684a0` passes all 41 package verifiers, 629 runtime tests (50 unrelated infrastructure skips), 61 harness tests and 24 actual app assertions across six pinned application adapters. The installed-consumer check packs runtime and capability-manifest, verifies all six JavaScript entry points and strict valid/invalid TypeScript consumers, and passes in CI. Registry dependencies are reused from the installed dependency tree.

The composed legacy migration rehearsal passes actual Engine export → reviewed composition → fenced import → verification/replay on SQLite and native PostgreSQL. Its legacy source is synthetic; deployment source completeness, target scalar/rule validation and production cutover remain explicit gates. See `composed-migration.md`.

All CI jobs pass in [run 35879253526](https://github.com/gmackie/forgec/actions/runs/35879253526), including Node22/24, compiler, packaging, differential and console acceptance. The pre-existing workflow idempotency race (#72 / draft #73) remains fixed. Earlier source receipts remain historical evidence.

Hosted database certification passes all 42 cells at the current implementation checkpoint. `provider-evidence/certification.json` retains the validated source/artifact/identity/raw-report index. One initial D1 Operations transport failure is retained alongside the successful full-profile retry; see the retry notes.

## New issue wave

Foundation #79 (resource relations) and #80 (settlement) extend the registered scope to 43 packages. Their implementation and fresh integrated evidence are in progress. The 41-package/42-provider-cell checkpoint above remains historical evidence for `9c92db7b`, not certification of this new wave. Application integration/staging enablement is deferred by user request. The ConceptIR semantic dependencies are recorded in `resource-settlement-semantics.md` and remain distinct acceptance gates.
