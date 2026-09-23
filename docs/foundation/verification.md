# Current Foundation implementation verification

Issues #26–29 have executable evidence for all 26 acceptance criteria, recorded
as `passing` with `verification: local` and test-file references in each contract.
The remaining 187 criteria are still planned. The verifier validates evidence paths;
a contract-only run does not execute the tests or certify hosted providers.

Run `node scripts/verify-foundation.mjs --suite local --package <slug>` for
`specification`, `artifact`, `identifiers` or `participation`. Each suite rebuilds
package and consumer fixtures twice, checks determinism and runs memory/SQLite tests.
The specification suite also tests real local Git objects and artifact provenance.
The artifact suite includes the blob race regressions. The participation suite
includes a live policy/PIP example with uncached authorization and paginated facts.

Validation on 2026-09-22: 287 runtime tests passed, 104 hosted-provider tests skipped;
runtime build/typecheck and six verifier unit tests passed.

The runtime suite exercises all four packages together. Consumer fixtures cover
seven pinned-instance domains, four artifact roles, GitHub/serial/healthcare alternate
identifiers, and team/classroom/review-board membership. Fixtures are synthetic;
external production adoption and live hosted provider certification are not claimed.

Manifest digests now use `sha256:<hex>` consistently across specification and artifact;
existing experimental raw-hex realization values need an explicit migration. Artifact
component membership uses immutable linked descriptors, avoiding any dependency on
the still-unimplemented general transaction-local read overlay. Participation permits
different-start overlapping memberships; domains may impose stricter policies.

The historical baseline below records the first composition change, before these
package slices and the Studio/runtime integration.

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
