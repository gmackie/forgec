# Deployment lane exclusivity

`Deployment` reserves `(tenant, application, stage, target)` while its lifecycle status is Pending, Deploying or HealthChecking. Reaching Active or Failed releases that claim. Another tenant has an independent lane.

```sh
cargo run -p forgegraph-cli --bin forgec -- build examples/deployment-lanes
```

The generated SQLite/Postgres plan uses a partial unique index. DynamoDB acquires/releases a conditional claim item in the same transaction as the entity/version update. In memory, the same commit guards the claim and record atomically. Conflicts use `UniqueConflict` with the invariant identity.

The initial grammar is `unique <key fields> [within <scope fields>] while <enum/status field> in [Member, ...]`. Enum members resolve to wire values; values are sorted and deduplicated. Predicate fields and members must exist. The resource must be `@versioned` to guard against stale claim releases. Conditional keys must be required and scalar/identity/enum values. A conditional unique cannot cover an unconditional `find` operation. Equivalent duplicate declarations are rejected. Different conditions on the same key create separate claims, with a stable predicate digest in each invariant identity.

Changing a condition requires checking existing data and rebuilding SQL indexes/DynamoDB claims before switching artifacts. Compatibility reports this as migration work; it does not perform a live migration. Soft deletion does not automatically release claims: the declared predicate controls exclusivity, matching the existing retained uniqueness semantics.

The checked-in runtime fixture under `conformance/fixtures/deployment-lanes` is generated from this package. Runtime tests exercise concurrent create attempts, tenant isolation, lifecycle release, matching-to-matching transitions and key changes using memory, actual SQLite and real PostgreSQL through raw-pg and Drizzle. The same scenarios verify multi-document rollback. PostgreSQL tests use isolated schemas when FORGE_PG_URL is configured and run in the hosted Node CI matrix. DynamoDB execution is still a transaction-shape probe; live DynamoDB certification remains outstanding.
