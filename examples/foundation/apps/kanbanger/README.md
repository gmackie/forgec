# Kanbanger Intake adoption

This opt-in application service reads an existing Kanbanger issue and its team
under an authenticated workspace, then reconciles Intake.Submission and the typed
IssueSubmission satellite. It is exported alongside createIssue from the real
shared issue service used by tRPC and Linear GraphQL. Existing request handlers do
not enable it automatically. No deployed service or database has been changed.

Source worktree: `/Volumes/dev/.worktrees/kanbanger/foundation-adoption`.
The exact reviewed source SHA and file hashes are in verification.json. The
app-source.patch file permits applying the three owned application changes to
another checkout of baseline d20e23a4 (use the full revision from local JJ when
reviewing). The generated Foundation package imports the actual Intake package.

After normal server-side workspace authorization, call
`reconcileIssueFoundationIntake(db, workspaceId, issueId, port)`, where `port` is
`kanbangerIntake(engine, context, {creatorId, formId, submitterId}, Effect.runPromise)`.
The binding explicitly maps one app creator to a tenant-local Party; user IDs are
not cast to Foundation IDs. The form points to an exact SpecificationPin. Neither
mutable title nor status is promoted into immutable intake authority.

Retry the reconciliation with the existing issue ID. It never calls createIssue
and never writes the app DB. Stable per-issue idempotency keys recover an
interruption between Submission and IssueSubmission. Contradictory replay fails.
This is explicit operator/application reconciliation, not a durable background
outbox or automatic production synchronization. Authenticated workspace context
must come from the server, not a request body.

Verification executes the real application service with a controlled application
DB read and real generated Foundation runtime/storage on memory, SQLite and native
PostgreSQL. It checks partial-write recovery, identity retention, replay mismatch,
and cross-workspace rejection. It does not certify the deployed Kanbanger DB or
external side effects. The app unit test separately checks query scoping.

Set FORGE_FOUNDATION_KANBANGER_ROOT to the app worktree and run the shared explicit
Foundation apps verifier with PostgreSQL configured. Ordinary runtime CI does not
auto-discover the `.traces.ts` file. App unit test passes. Full app typecheck and
lint/build are currently blocked by pre-existing missing @forgegraph/otel exports
and ESLint configuration. No failures were reported in the new service itself.

Installable adapter: `@forgegraph/runtime/foundation/apps/kanbanger`. The local `adapter.ts` reexports the same implementation used by the packaged runtime. Build the corresponding Forge schema for the selected deployment before wiring the port.
