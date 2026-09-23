# Integration

Connection fixes provider, direction, authority policy and a kernel credential
binding name. No secret bytes or provider JSON are stored. ExternalMapping joins a
qualified Identifier and a LineageNode; domain-owned GitHub, Linear and industrial
types preserve canonical Forge resource identities.

SyncRun pins Reconciliation desired revision and Fulfillment, expected record count,
previous cursor and opaque next token. AcceptedRecord stores immutable mapping,
lineage and sealed evidence in a consecutive 1..128 chain. SyncSeal must select the
complete declared prefix. SyncCursor publishes only that seal, checks the exact
previous cursor, and competes for the unique next connection ordinal. Recreated
helpers can recover accepted work before or after checkpoint publication without
skipping the declared batch. Each connection supports 128 checkpoint publications.

Provider adapters remain responsible for declaring complete source batches and
writing domain changes before acceptance. The package proves durable acceptance of
the declared records; it cannot discover omitted provider data or make remote side
effects atomic with local storage. Empty heartbeats do not advance a cursor. Opaque
tokens use compare-and-set sequencing, not fabricated lexical provider ordering.

WebhookReceipt deduplicates connection/provider-event identity and binds digest and
sealed support. Concurrent duplicates return the same authorized receipt; altered
content fails. Receipt is durable capture, not proof that all processing completed.
SyncConflict pins mapping, connection and same-scope Reconciliation drift. Explicit
SyncResolution preserves selected authority and evidence; kernel policy must govern
who may resolve it. OutboundDelivery links real DeliveryIntent; provider-specific
exactly-once behavior is not promised.

Memory, SQLite and local PostgreSQL traces pass for synthetic GitHub, Linear-style
issue and industrial integrations, including checkpoint crash boundaries, concurrent
advance, webhook races, real Reconciliation/Lineage/Fulfillment/Evidence/Delivery,
immutable history and authorization. No live provider network operations or hosted
D1/DynamoDB certification are claimed; F47-STORE remains planned.
