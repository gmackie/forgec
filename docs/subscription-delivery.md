# Subscription delivery and recovery

`Engine.consume` completes a delivery only after the handler succeeds. Completion,
resource writes, audit records, and staged publications share one storage transaction.
This includes handlers that only publish or return without writing a resource.

The inbox identity is `(tenant, subscription, messageId)`. A hash of the channel,
message type, and payload rejects reuse of that identity with different content.
New consumers also consult the legacy processed ledger, so historical completions
remain deduplicated. Old ledger entries cannot distinguish successful handlers from
those affected by #188; investigate those entries before manually replaying them.

## Claim and commit protocol

The existing `forge_document` storage holds `subscription-delivery-v1` records, with
an ID encoded by `encodeIdentity([subscription, messageId])`. No schema migration
is required. A document version is the fencing token:

- `running`: a worker owns a 60-second claim. Concurrent delivery raises retryable
  `TransientConflict`; the transport must not acknowledge it as a duplicate.
- `ready`: a failed handler that made no external call can retry immediately.
- An expired `running` claim can be taken over using document compare-and-swap.
  The previous worker cannot commit after takeover: completion checks its document
  version in the same transaction as all handler writes.
- `external`: durable intent has been recorded before calling an external binding.
  These records do not expire into automatic replay, because the effect may already
  have happened. An expired claim cannot start its first external call.
- `complete`: delivery is acknowledged. Subsequent delivery returns `duplicate`.

A lost commit response is safe: redelivery reads `complete`, and failure cleanup
cannot overwrite it. Crash recovery relies on redelivery by the queue or dispatcher;
there is no background inbox scanner. The lease does not cancel an old handler's
computation. Its staged mutations remain fenced, and declared external calls must
establish intent before execution. Handler code must use the declared dependency
API for effects; arbitrary network calls outside that API cannot be tracked.

All calls within one handler share the external-intent transition, including calls
started concurrently. This protects against replay of a delivery, not repeated or
non-idempotent calls intentionally made by application code within one invocation.

## Unknown external outcomes

After an external call begins, a handler failure or incomplete delivery returns
`DeliveryOutcomeUnknown`. This is non-retryable at the handler level. Current queue
hosts may redeliver it until their dead-letter policy applies; each redelivery
rechecks the durable record and does not repeat the effect. Reads are conservatively
treated the same as writes because external bindings do not declare effect semantics.

The generic `Dispatcher.consumer` callback is opaque: it cannot stage its effects in
our transaction. Its entire invocation is treated as external. Use `Engine.consume`
for handlers whose local mutations must be safely retried. An opaque callback's
failure is unknown, never reported as a successful duplicate.

For reconciliation, stop/drain the affected consumer and ensure the previous
invocation has terminated. Read the document by tenant, kind, and encoded ID. Check
the vendor's durable result using the message identity or application correlation
key. Keep the record parked until the outcome is established. Through a reviewed
administrative repair using `Storage.putDocument` and its observed `_version`:

- If no effect occurred and retry is safe, preserve the identity/hash and set
  `status: "ready"`, then redrive the queued message.
- If all required work is confirmed complete, set `status: "complete"`.
- If only the vendor effect happened, reconcile missing local work first; marking
  complete would otherwise discard that work. This requires application-specific
  repair and is not automated by the runtime.

Record the evidence for the repair. Never delete the inbox row or blindly release
an `external` record while the original worker could still run. Connector-specific
reconciliation and live vendor qualification remain tracked by #189.

## Upgrade and adapter contract

Drain old consumers before upgrading; mixed old/new consumers are unsupported since
old consumers acknowledge before success. A downgrade must also drain and reconcile
new inbox records; old consumers do not read the new completion documents.

Custom storage adapters must implement `hasProcessed`, advertise `atomicCompletion`,
and enforce `CommitPlan.completion` as an atomic document CAS with every plan effect.
The consumer refuses adapters without this capability. Memory, D1, PostgreSQL, and
DynamoDB implement it; DynamoDB includes the completion write in its transaction
budget. No exactly-once guarantee is made for external vendor effects.

## Evidence

`packages/runtime/test/subscription-delivery.test.ts` runs the same fault scenarios
on memory and SQLite by default, PostgreSQL with `FORGE_PG_URL`, local D1 with
`FORGE_D1_HARNESS`, and DynamoDB Local with `FORGE_DYNAMO_ENDPOINT`. Scenarios include
concurrency, lease takeover, stale mutation rejection, lost commit responses,
publication-only retry, external-only completion, concurrent external calls,
unknown outcomes, payload mismatch, and legacy/tenant isolation. Local D1 runs via
the test harness's SQL executor; this is adapter evidence, not live Queue/SQS or
vendor-account certification.
