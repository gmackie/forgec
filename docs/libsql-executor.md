# Experimental libSQL executor

`@forgegraph/runtime/libsql-executor` adapts a caller-owned libSQL client to
`SqlExecutor`. It is usable with the SQL artifact publication journal and is
intended as the first Turso seam, not a certified production profile.

```ts
import { createClient } from '@libsql/client';
import { libsqlExecutor } from '@forgegraph/runtime/libsql-executor';
import { SqlArtifactPublicationJournal } from '@forgegraph/runtime/artifact-publication-sql';

const client = createClient({ url: configuredDatabaseUrl, authToken: resolvedToken });
const sql = libsqlExecutor(client);
const journal = new SqlArtifactPublicationJournal(sql);
await journal.initialize(); // provisioning only
// Compose journal into ArtifactPublisher. The host owns client.close().
```

Credentials and endpoint are composition-root configuration. The adapter has no
SDK runtime dependency; consumers install their selected client. Tests pin
`@libsql/client` 0.18.0. Finite numbers, strings, bigint, null, byte arrays and
ArrayBuffers are supported. Unsupported values fail before a batch is submitted.
Rows use the configured client's number/blob conversion policy; callers must
choose integer handling compatible with their runtime schema.

Every batch delegates to `client.batch(statements, 'write')`, the client's atomic
write transaction. A JS loop of individual executions is not substituted. Results
retain affected-row counts for guards and journal claims. Standalone reads and
writes use client.execute; replication/read-session policy remains the host's
responsibility. Do not select an embedded replica for authoritative publication
receipts without independently proving read-after-write and failover semantics.

Tests run the actual libSQL native engine locally: null/blob round trips, affected
rows, rollback on a later uniqueness violation, successful multi-statement batches,
concurrent journal claims and immutable terminal receipts. Hosted Turso credentials
are not configured in this session, so remote concurrency, reference/absence
guards, replica consistency and production failover remain unqualified. This
export does not add a compiler target or advertise D1-equivalent certification.

The shared Foundation fixture now runs the same suites with a real native libSQL client and `D1Storage(libsqlExecutor(client), model)`. This includes reference rules, atomic absence guards, concurrent claims, application adapters and rollback behavior. The full runtime run on 2026-10-02 passed 840 tests (127 unrelated/hosted tests skipped), including 140 additional Foundation cases on libSQL and an explicit check that the fixture did not fall back to SQLite. This strengthens local semantic coverage; remote Turso transport, credentials and production operating behavior remain unqualified.
