# Change contract

Issue #41 implementation. Direct dependencies: Decision, Specification, Evaluation,
Fulfillment and Evidence. README.md describes executable semantics and limits.
contract.json preserves F41-01..07, R01, R02, AUTH and STORE acceptance identities.

Local passing evidence uses generated consumer bundles and real runtime services on
memory, SQLite and PostgreSQL: exact immutable revision pins, fixed approval gates,
validated Decision outcomes, impact/implementation/verification references, sealed
evidence, explicit reverse-change rollback, forward-only supersession, concurrent
approval versus implementation, rejected approval, required/optional verification,
idempotent completion, immutability and cross-tenant/denied access.

Run forgec fmt/lock/check on the package and fixtures/consumer; build both twice and
compare files. Run test/foundation-change.test.ts with FORGE_FOUNDATION_CONSUMER set
to the generated consumer and FORGE_FOUNDATION_PG_URL for local PostgreSQL; then run
runtime typecheck. These are synthetic composition fixtures, not app dogfooding.
F41-STORE remains planned because hosted D1/DynamoDB have not run. Raw candidate
reads are not approval authority; use Changes state and command validation.
