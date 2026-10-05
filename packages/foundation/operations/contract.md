# Operations contract

Issue #45 implementation. Direct dependencies: Specification, Allocation, Fulfillment,
Usage, Lineage, Evaluation and Evidence. README.md defines resource ownership,
immutable plan/actual distinction, terminal cleanup protocol and explicit limits.

F45-01..07, R01, R02 and AUTH have local passing evidence in generated consumer tests
on memory, SQLite and PostgreSQL. Real lower implementations enforce capacity,
usage deduplication, sealed transformation provenance and typed evaluation support.
Actual WorkQueue enqueue storage exercises task linkage without claiming worker
execution or that queue success proves business completion. Manufacturing/lab/Bob/
media fixtures are synthetic contract tests, not live application dogfooding.

F45-STORE remains planned. Independently run forgec fmt/lock/check for package and
fixtures/consumer, build both twice and compare outputs, run
 test/foundation-operations.test.ts with FORGE_FOUNDATION_CONSUMER and
FORGE_FOUNDATION_PG_URL, then runtime typecheck. Plan chains are bounded to 16.
Preparation and cleanup are resumable protocols, not multi-provider transactions.
