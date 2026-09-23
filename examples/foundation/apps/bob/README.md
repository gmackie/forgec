# Bob Fulfillment adoption

This opt-in application service reads a persisted completed taskRuns row under
an authenticated user and workspace, then reconciles FulfillmentEnd and a typed
RunCompletion satellite. It is exported by the real planningWriteService.
Existing completion handlers do not enable it automatically. No deployed service
or database has been changed.

Source worktree: `/Volumes/dev/.worktrees/bob/foundation-adoption`.
verification.json pins the source revision and exact service/schema hashes.
app-source.patch contains the three owned application changes for a separate app
review. Source baseline is 7863b955 (local JJ repository).

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
workspace isolation. The app unit test checks query scoping; app API typecheck
passes. Set FORGE_FOUNDATION_BOB_ROOT to the prepared worktree when using the
shared apps verifier. Ordinary runtime CI does not discover this `.traces.ts` file.
