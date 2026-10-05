# Master Data contract

Implementation for issue #62 under Foundation epic #25. Direct dependencies are
Identifiers, Lineage, Evaluation, Decision and Reconciliation. Boundary semantics,
limits and provider coverage are documented in README.md. contract.json preserves
all source acceptance IDs, F62-01 through F62-06, with local passing evidence.

## Verified behavior

Generated customer, supplier and asset consumers create typed source and canonical
handles. Completed matching evaluations and validated finalized decisions establish
survivorship provenance. Canonical choices bind selected options to targets, and
lineage relations bind source and target nodes. Immutable mapping journals serialize
competing writes and restore previous targets on unmerge without erasing records.

Tests run real generated bundles through Engine on memory, SQLite and PostgreSQL.
They reject namespace collisions, incorrect domain resource IDs, invalid canonical
choices, stale replay, cross-tenant references and denied operations. History reads
fail closed when rows are hidden. Idempotent initial mapping and unmerge survive a
new helper instance. All lower packages are concrete implementations, not mocks.

## Independent verification

Run forgec fmt/lock/check for this package and fixtures/consumer, then build each
twice and compare artifacts. Run test/foundation-master-data.test.ts with
FORGE_FOUNDATION_CONSUMER set to the generated consumer directory. Set
FORGE_FOUNDATION_PG_URL to enable PostgreSQL through foundationAdapters. Run runtime
typecheck. No hosted D1 or DynamoDB certification is claimed.

The accepted baseline is Reconciliation bb08c8da095a81d55231814dca19bce329179134,
which includes the accepted Decision, Evaluation, Identifiers and Lineage packages.
Lockfiles bind exact dependency/compiler fingerprints. This source-scoped protocol
has a 128-event bound and does not promise physical entity merging or multi-source
atomicity. Desired revisions are pinned provenance, not an external side-effect fence.
