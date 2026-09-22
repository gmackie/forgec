# Current Foundation implementation verification

The integrated `business-studio` workspace now includes executable experimental
packages for specification (#26), artifact (#27), identifiers (#28) and participation
(#29). Their READMEs describe implemented behavior and outstanding acceptance. The
213 contract entries remain planned; local slices do not establish full acceptance.

Run `node scripts/verify-foundation.mjs --suite local --package <slug>` for any of
those four slugs or `composition`. Package verifiers build twice, compare generated
artifacts and run memory/SQLite tests against the fresh output. Live provider mode
still fails explicitly; no skipped test is counted as certification.

Latest integrated verification (2026-09-22): Rust workspace tests and strict Clippy
passed; runtime TypeScript checking passed; runtime suite 278 passed / 104 skipped.
Regressions cover append-only operation enforcement, exact source pins, retained
identifier claims, participation history, unreadable terminal facts, sealed-copy
hashing, finalizer races, write-once publication, empty content and governed downloads.
Typed consumer fixtures compile against real co-deployed package dependencies.

The specification package still needs live Git adapters and authenticated map
provenance. Artifact manifest membership freezing/relocation remains unimplemented.
Identifiers currently have one normalization profile. Participation currently permits
different-start overlaps and has no live PIP freshness/epoch integration. Kernel
staged references and repeated-record transaction composition remain unresolved.

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
