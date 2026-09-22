# First Foundation slice verification

Verified 2026-09-22 in the `foundation-integration` JJ workspace, based on GitHub main `36dccaa30d24ac4e70f8032b9f7bbca27f57dfe8`.

This change implements explicit package co-deployment and its first runtime composition probe. It establishes contracts for all 25 Foundation packages; it does not implement their runtime schemas or mark package acceptance complete.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Passed |
| `cargo test --workspace --locked` | 99 passed |
| `node --test scripts/test/verify-foundation.test.mjs` | 5 passed |
| `pnpm foundation:contracts` | 25 packages, 213 acceptance cases, zero graph/catalog errors |
| `pnpm foundation:composition` | Two identical builds; 5 runtime cases passed |
| `./scripts/refresh-fixtures.sh` | Generated new composition baseline; existing conformance fixtures unchanged |
| `pnpm --filter @forgegraph/runtime typecheck` | Passed |
| `pnpm --filter @forgegraph/runtime build` | Passed |
| `pnpm --filter @forgegraph/runtime test` | 237 passed, 104 skipped; required external provider infrastructure was not configured |
| `node scripts/check-workflows.mjs` | Passed |

The composition probe was first run against the original compiler and failed all five cases: the dependency aggregate was absent from the model. It passes against the assembled bundle. Three additional memory regressions verify atomic rollback/conditional guard behavior; known staged-reference/read-your-writes failures remain explicit in `kernel-gaps.md`.

An independent agent reviewed the merged compiler and harness. It verified extension rejection/verification, recursive workflow reference validation, target compatibility, observability ownership, catalog consistency and fixture freshness wiring; no blocking finding remained in this slice.

## Limits

No live D1, PostgreSQL or DynamoDB certification was performed. Standard runtime tests skip infrastructure-dependent cases; these skips are not Foundation acceptance evidence. The dedicated Foundation provider mode fails until a real verifier exists.

Physical name collisions are rejected rather than namespaced. Assembled extension packages are rejected until extension pin assembly is implemented. Facets, patterns, signed provenance integration, nested atomic callable dispatch and full G1 acceptance remain open. The existing facet/source-map branches have not been merged into this change. All 25 package acceptance contracts remain `planned`.

Execution plan: https://syhczsdoad8z.postplan.dev
Tracking: https://github.com/gmackie/forgec/issues/25 and child issues #26–50.
