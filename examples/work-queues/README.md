# Portable bounded work queues

`AgentWork` and `VerificationBuilds` declare an execution function, lease,
maximum attempts (`retry`), task capacity and runner capacity. Compile this
package to inspect the `workQueues` IR. Instantiate the exported runtime
`WorkQueue` service with that definition, a storage adapter and a clock.

`enqueueDerived` derives requirements from pinned execution manifests (#9) and
stores the complete immutable snapshot on the task. `enqueue` accepts an already
materialized snapshot and verifies its digest and operation identity. A digest
is integrity, not authentication: only trusted application code should enqueue.
The host must authenticate runners and authorize every service call; this slice
does not publish unauthenticated HTTP endpoints.

Framework state lives in one CAS document per tenant/queue. Task input is separate
from sealed status/generation/attempt/lease fields. Claims sort by priority DESC,
createdAt ASC, then task ID. Capabilities match all-of; only recently registered
online runners claim. Heartbeats extend task leases and runner presence. Reaping
requeues expired attempts or exhausts them at the attempt bound. Old generations,
expired claims and cancelled tasks reject worker writes. Completion requires start.
A completed result and its evidence entry commit atomically. Changed queue
definitions fail closed until the queue is drained/migrated.

This portable profile is bounded to 128 retained tasks, 64 runners, ten attempts
and 256 KiB total state. It rejects overflow; it never scans an unbounded table.
Terminal evidence remains retained, so capacity includes completed tasks. Automatic
archival, high-throughput indexed storage, task/runner resource extensions and
provider-host HTTP wiring remain outstanding. In-process and Cloudflare Queue
wake adapters are advisory; hosts must poll/reap even when wake delivery fails.

The observer receives operation kind and queue depth, never task input/results.
It is a hook for host telemetry, not yet a generated metrics dashboard. Tests
cover memory and real SQLite through D1Storage, competing claims, ordering,
capability matching, fencing, expiry, retries, cancellation and restart. Live D1
certification and a distributed runner deployment remain outstanding.
