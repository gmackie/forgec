# Operation state models

## Mutation (single logical command)

```
received -> authenticated -> decoded -> loaded -> validated -> planned
   -> committed -> responded
   \-> rejected(code)        at any step before commit
   \-> failed(code)          provider failure at commit; nothing persisted
```

Commit is one provider transaction (D1 batch / Dynamo TransactWriteItems)
carrying: record change, integrity metadata (unique claims, access items,
reference guards), audit row, idempotency receipt, outbox rows. After commit,
delivery of outbox rows is asynchronous and idempotent.

Retry policy inside the engine: `TransientConflict` class only, bounded
(default 3 attempts, jittered backoff), **same** generated ids/timestamps.
A `VersionConflict` is never retried by the engine.

## Idempotency receipt

Key: `(tenant, operation id, idempotency key)`. Stored in the commit
transaction with the request hash and the canonical response.

| state | behaviour on replay |
| --- | --- |
| absent | execute |
| present, same hash | return stored response, no effects |
| present, different hash | `IdempotencyMismatch` |
| present, in-flight (Dynamo token window / D1 row without response) | `TransientConflict` (client retries) |

Window: 24h default, configurable per operation.

## Changeset (bulk)

```
proposed -> previewed -> approved -> committing -> committed
                     \-> rejected             \-> partially-committed (resumable mode only)
                                              \-> failed (atomic mode: nothing persisted)
```

An approval binds `(changeset id, content hash)`; commit re-verifies hash,
permissions, revisions, and state predicates. Atomic mode is allowed only
within the compiled physical budget; preview reports the bound.

## Outbox row

```
pending --claim--> leased --complete--> delivered
  ^                  |
  |   lease expiry   |
  +------------------+                 attempts > max  --> dead (DLQ, alert)
```

Claim and complete are conditional updates fenced by lease owner (validated in
the M0 spikes on both providers). Per-subscription delivery status for
broadcast channels: one row per (message, subscription).

## Blob

```
intent -> uploading -> uploaded -> verifying -> ready
                                \-> rejected
```

Finalization seals immutable bytes (copy/version) before `ready`.

## Job

```
queued -> running -> succeeded
                  \-> failed
                  \-> cancelled
```

Progress and a result location are exposed on `GET /v1/jobs/{id}`.

## Projection generation

```
building -> validating -> active -> retired
                       \-> failed
```

Exactly one active generation per projection; reads report generation,
checkpoint, and freshness.

Resource expressions support at most one reference hop (`record.field`). The
compiler reports `E-EXPR-003` for paths that dereference another stored identity
such as `record.parent.field`. Runtime bundle loading rejects these paths in
rules and derived fields, including bundles produced by older compilers. Bind a
direct reference and enforce its relationship explicitly instead. Enum and
lifecycle-state literals are not reference traversal. This restriction avoids
interpreting unresolved IDs as null and does not imply transactional support
for arbitrary graph traversal.
