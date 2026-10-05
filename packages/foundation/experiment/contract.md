# Experiment contract

Issue #42 implementation (not #60). Direct dependencies: Specification,
Participation, Allocation, Fulfillment, Evaluation, Evidence, Artifact and Lineage.
README.md records precise semantics, deterministic assignment convention, lifecycle,
bounds and the explicit pending-allocation recovery protocol.

F42-01..06, R01, R02 and AUTH have local passing evidence in the generated consumer
runtime test on memory, SQLite and PostgreSQL. Real lower services enforce capacity;
real artifact upload/finalize/publication verifies output provenance. Fixtures for
A/B, LLM, LevelForge and manufacturing are synthetic contract tests, not dogfooding.
F42-STORE remains planned: hosted D1/DynamoDB have not run.

Independent verification: forgec fmt/lock/check package and fixtures/consumer, build
each twice and compare all generated files, run test/foundation-experiment.test.ts
with FORGE_FOUNDATION_CONSUMER and FORGE_FOUNDATION_PG_URL, and runtime typecheck.
Use Experiments.state for validated accepted assignments; raw candidates are inert.
Historical allocation grants do not authorize current use after release. Failed
cross-system publication retains a pending allocation for explicit operator release.
