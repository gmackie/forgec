# Reconciliation

Immutable DesiredRevision facts pin exact SpecificationPin revisions. Observations
join a completed EvaluationRun, its matching EvaluationFinish and sealed evidence.
Typed domain satellites hold deployment replicas, device configuration and repository
policy; there is no universal JSON state document. Drift records exact specification
pin, semantic anchor, field and explanation. These are hooks for a consumer source
map, not invented source positions or a built-in source-map resolver.

ReconciliationEvent is the authoritative journal for each scope. Consecutive unique
ordinals serialize Desired, Attempt and Result facts; changing desired intent and
publishing results compete for the same next ordinal. A result cannot overwrite a
newer desired revision. Old candidate attempts/results remain immutable history,
but only journal-selected facts are authoritative. There is no mutable latest pointer.
Journal traversal fails closed on unreadable entries. Each scope supports at most
128 events and desired sequence 1..128; exceeding that bound fails validation.

Corrective attempts pin the observation and typed Fulfillment. Terminal results are
unique per attempt and carry Converged, Failed or Uncertain plus sealed support.
Retrying a command uses Engine idempotency keys; a new corrective execution needs a
new attempt identity. Uncertain means the controller does not know the external
outcome and must reobserve before deciding further work. The kernel preserves facts;
it does not infer convergence from an external acknowledgment.

The separately compiled actor-preview controller fixture uses a real keyed ActorHost,
durable effects, duplicate-message receipts, restart and generation takeover. Its
transport IDs are resolved through the typed Reconciliations adapter. Separation is
required because the current compiler rejects importing normal-profile business
packages into actor-preview assemblies. Run the controller build into
conformance/fixtures/reconciliation-controller, or set FORGE_RECONCILIATION_CONTROLLER.
Business consumer fixtures use the normal profile.

assertCurrent checks the durable journal before executing a provider action. External
providers must also enforce their own desired-revision fence: a local preflight
cannot prevent an external operation racing a new revision. Memory and SQLite
concurrency, retry, authorization and actor traces pass. Live PostgreSQL, D1 and
DynamoDB certification remains planned (F46-STORE). PostgreSQL tests can be enabled
with FORGE_FOUNDATION_PG_URL; no hosted-provider execution is claimed here.
