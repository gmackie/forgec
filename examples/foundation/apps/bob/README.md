# Bob Fulfillment adoption

This opt-in application service reads a persisted completed taskRuns row under
an authenticated user and workspace, then reconciles FulfillmentEnd and a typed
RunCompletion satellite. It is exported by the real planningWriteService.
Existing completion handlers do not enable it automatically. No deployed service
or database has been changed.

Source worktree: `/Volumes/dev/.worktrees/bob/foundation-current`.
verification.json pins the source revision and exact service/schema hashes.
Bob main at f388e25f already contains the strengthened service (merged PR #210),
including real PGlite-backed native tests. The former app-source.patch is retained
as historical provenance only; do not apply it to current main.

Call `reconcileRunFoundationCompletion(db, {userId, workspaceId}, taskRunId, port)`
after normal server authorization; construct the port with
`bobCompletion(engine, context, {taskRunId, fulfillmentId}, Effect.runPromise)`.
The trusted binding identifies an already requested and started Fulfillment.
Bob taskRuns has no startedAt, so creation time is never fabricated into a start.
The actual completedAt, session, planning item, task run and user are retained.
Completion describes recorded execution only; it does not certify PR review,
merge, business delivery or evidence that Bob did not record.

This explicit reconciliation never executes a task or updates the Bob DB. Retry
with the same persisted run ID after a Foundation failure. Stable idempotency
keys recover interruptions between the terminal fact and its satellite. Changed
completion timestamps are rejected. No background outbox or automatic deployed
synchronization is claimed.

The explicit Foundation app trace imports the real source service, controls only
the app DB read, and executes the generated Foundation runtime on memory, SQLite
and native PostgreSQL. It checks missing-start rejection, partial-write recovery,
exact terminal facts, replay mismatch, nonterminal source rejection and user/
workspace isolation. Twelve native PGlite tests and the app API typecheck pass on Node24. Set FORGE_FOUNDATION_BOB_ROOT to the prepared worktree when using the
shared apps verifier. Ordinary runtime CI does not discover this `.traces.ts` file.

Installable adapter: `@forgegraph/runtime/foundation/apps/bob`. The local `adapter.ts` reexports the same implementation used by the packaged runtime. Build the corresponding Forge schema for the selected deployment before wiring the port.
