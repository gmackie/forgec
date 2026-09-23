# Operations

Operation owns business identity and exact SpecificationPin. OperationRun pins an
immutable selected plan, UsageStream and UsageSource; it is distinct from a queue
task. PlannedAllocationLink forms a maximum-16 reservation snapshot. Actual links
pin real Allocation allocate grants and are selected by OperationStart. Unique
OperationReservationClaim ownership prevents another run from consuming or releasing
the same selected plan. Start validates current allocated claims for actual links;
planned but unused holds remain distinct from resources actually used.

Allocate/reserve through Allocation before starting the run. Start claims plans as
a resumable sequence; failure can leave ownership claims for the same run to retry.
This is not multi-pool atomic allocation. Do not schedule new allocations against a
run after its start snapshot or terminal outcome. Abandoning a partially prepared
run requires explicit lower Allocation cleanup; active-run cancellation is the
supported terminal command. Resource-free runs may start with no actual grants.

OperationFulfillmentLink permits multiple concrete fulfillments. The consumer tests
use the real Fulfillments.enqueueTask bridge, real WorkQueue storage and execution
requirements derived from the compiled consumer function. Queue enqueue and business
completion remain distinct; this package does not provide domain worker code.
OperationUsageLink records immutable source events via Usage.ingest, preserving
source/event deduplication across retries. Late actual usage is retained rather than
silently discarded because a run was cancelled. Lineage links pin a sealed typed
transformation, including its exact selected inputs and outputs. Completed runs
require a completed evaluation with sealed support, not an inferred domain pass.

Unique OperationEnd serializes complete/fail/cancel outcomes. Cleanup then cancels
unused reservations and releases actual allocations using stable lower command keys.
A crash between terminal commit and cleanup exposes cleanupPending and can resume
through cleanup(). State validates actual allocation inactivity even if a raw early
cleanup marker exists. Cancellation preserves all usage and lineage. Raw candidate
reads are not validated execution or cleanup authority; use Operations.state.

Synthetic manufacturing, laboratory, Bob development and media production consumers
pass on memory, SQLite and local PostgreSQL. Traces cover ownership isolation,
duplicate usage, two task/fulfillment links, actual capacity, sealed lineage,
evaluation/evidence, crash recovery, completion/cancellation races and authorization.
Hosted D1/DynamoDB are unverified; F45-STORE remains planned.
