# Partitioned issue numbers

`Issue.number` allocates a monotonically increasing number per tenant/project.
`Ticket.number` demonstrates a global sequence within each tenant and exhaustion.

```forge
number : integer @sequence(partition: project, start: 1, max: 1000000)
```

The sequence identity is the resource ID plus field name. Omitting `partition`
creates one sequence per tenant. Bounds default to 1 and the largest safe JSON
integer. Allocation requires an unrefined required integer without a default or
derivation. Partitions are required text, ID, enum or resource-reference fields.
The compiler makes partition fields immutable and allocated fields server-owned.

The engine reserves a value with a durable compare-and-swap before committing the
resource row, audit and idempotency receipt together. Failed/abandoned reservations
leave gaps; reserved numbers are never returned to the pool. Concurrent commits
can finish in a different order from their reservations. This is not gap-free
numbering or a transactional counter rollback. Functions use the same allocator
through their declared resource create capability.

D1, PostgreSQL and DynamoDB use their existing durable document CAS adapter.
Tests cover concurrent memory/SQLite allocation, tenant/partition isolation,
idempotent replay, immutable fields and exhaustion. Live PostgreSQL/DynamoDB
certification is still outstanding. Declare a unique key over partition + number
for an additional storage invariant, as this fixture does.

Renames or partition/bound changes require high-water migration review. Existing
records must be backfilled and durable counter state migrated before activation.
Record-only snapshot migration does not preserve sequence reservations; counter
state must travel separately. Sequence creates in internal changeset previews
are explicitly rejected so previewing cannot consume numbers. Standalone named
sequences and a direct function allocation capability remain future work.
