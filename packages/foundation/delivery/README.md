# Delivery (experimental)

DeliveryIntent owns logical send identity, a typed destination handle, optional
immutable ArtifactRevision payload and a bounded retry count. Domain EmailDestination,
WebhookDestination and FileExportDestination satellites own endpoint details. Typed
EmailContent/WebhookContent/FileExport satellites own content; no JSON payload or
provider credentials are embedded in the common envelope.

A unique DeliveryStep(intent, number) chooses Send or Cancel. The first choice uses
number 1; retry/cancellation consumes the next consecutive number only after a
Failed receipt or a definitively Failed reconciliation of an Uncertain receipt.
Send respects maxAttempts (1..32); cancellation may occupy the next terminal slot.
This immutable claim makes cancellation and competing retries race atomically
without read-check-write state mutation. A claimed/in-flight attempt cannot be
cancelled until its outcome is definitively resolved. A successful delivery cannot
be retried or cancelled through the next-step rules.

DeliveryAttempt is unique per Send step and records startedAt, provider and its
idempotency key. Provider calls belong in an external adapter after durable claim
and attempt creation; this package does not include email/webhook/storage SDKs.
ProviderReference, namespaced callbackKey, completion time, failure detail and optional
EvidenceSeal belong to the unique immutable DeliveryReceipt. Contradictory late
callbacks cannot overwrite it. Uncertain receipts admit one immutable definitive
DeliveryResolution. A timeout never proves the provider performed no send.

`Deliveries.create` derives Engine idempotency from the logical key unless explicitly
supplied; `receipt` similarly uses callbackKey. Matching replay returns the existing
fact and conflicting input fails. Direct CRUD still enforces logical/ordinal/receipt
uniqueness. Claim/start intentionally do not manufacture retry keys that would let
multiple workers interpret one claim as permission for multiple provider calls.
The adapter must namespace provider callback keys and honor its provider idempotency
contract. There is no universal exactly-once external-send guarantee.

A crash after provider acceptance but before receipt persistence remains ambiguous.
Recover the durable attempt, record Uncertain if needed, and reconcile provider state
before retry. If uncertainty cannot be resolved, leave it unresolved rather than
blindly resending. If the adapter crashes after attempt creation but before sending,
the same conservative recovery applies. No claim lease silently expires into resend.

`outcome(step)` is a per-step historical status, not an inferred latest-intent status.
It reads terminal facts and receipt evidence with normal Engine authorization; a
hidden receipt/resolution fails closed. History is append-only and tenant-scoped.
Generated memory/SQLite tests cover typed fixtures, real artifact publication,
sealed receipt evidence, callback replay, competing claims/cancellation, retry limits,
ambiguous results, late callbacks, immutable history and authorization/tenant denial.
Hosted provider certification and actual provider SDK integration are not claimed.
