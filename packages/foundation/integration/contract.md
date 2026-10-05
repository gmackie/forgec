# Integration contract

Issue #47 implementation. Direct dependencies: Reconciliation, Identifiers, Delivery,
Fulfillment, Lineage and Evidence. README.md defines the durable acceptance-prefix
protocol, explicit provider-adapter obligations and bounded opaque cursor semantics.

F47-01..07, R01, R02 and AUTH have local passing evidence in generated consumer traces
on memory, SQLite and PostgreSQL. F47-STORE remains planned. Tests exercise actual
lower implementations and synthetic typed GitHub/Linear/industrial consumers, not
live application dogfooding. Credentials are external kernel binding names only.

Independent verification: forgec fmt/lock/check package and fixtures/consumer; build
each twice and compare all files; run test/foundation-integration.test.ts with
FORGE_FOUNDATION_CONSUMER and FORGE_FOUNDATION_PG_URL, then runtime typecheck.
