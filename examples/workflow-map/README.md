# Bounded map/collect

`EvaluateCandidates` maps a game candidate list to scores. `VerifyTargets` maps
business deployment targets to verification results. Both return results in
input order even when calls finish out of order.

```forge
step evaluations = map candidate in input.candidates concurrency 4 {
  EvaluateCandidate(candidate: candidate)
}
```

The input must be a nonoptional bounded list (up to 1024 elements). Concurrency
is required, from 1 to 32. The v1 body is one named-argument capability call;
loops, nested maps, catches inside the body and arbitrary reductions are absent.
A normal function can aggregate the collected result in a following step.
Graph hashes include source, binding, concurrency, bounds and call arguments.

The portable executor dispatches fixed waves. Each item has a stable identity
based on instance, map step and input index. CAS reservations prevent racing
drivers from dispatching the same live reservation; independently stored results
survive parent/host restart. Unhandled child errors fail the map before another
wave is dispatched. Cancellation prevents later waves; it cannot undo in-flight
side effects. Each result and the collected output are limited to 256 KiB.

Reservations expire after five minutes to recover abandoned attempts. Activities
must finish within that window and honor the supplied idempotency key for external
effects: after lease expiry an old process can still be running, and no database
lease can fence an external system on its own. Completed durable receipts are
reused. An interrupted activity without a receipt is retried, not claimed exactly
once. Long-running Runner jobs need the separate work-queue primitive.

Cloudflare, Step Functions and Temporal reuse this executor. Their drivers yield
before polling a running instance whose child is reserved by another driver.
Local tests cover ordering, concurrency, restart, races and errors. Live
Cloudflare/Temporal/distributed certification remains outstanding; this fixture
is not evidence of a live-provider pass.
