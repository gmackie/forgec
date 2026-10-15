# Sequential resource transactions

`Engine.transaction` provides an experimental bounded transaction body. Run
resource calls sequentially using the supplied context; return an Effect result.
The runtime stages mutations and calls the durable adapter's `commitAll` once.

```ts
const result = await Effect.runPromise(
  engine.transaction(
    (tx) =>
      Effect.gen(function* () {
        const parent = yield* tx.call("@acme/commerce/_/Customer.create", {
          code: "PARENT",
          name: "Parent",
        });
        const child = yield* tx.call("@acme/commerce/_/Site.create", {
          customer: parent.id,
          code: "HQ",
          name: "HQ",
          timezone: "UTC",
        });
        return { parent, child };
      }),
    context,
  ),
);
```

Point reads and reference validation see earlier staged records in the same
tenant. Each call runs the ordinary purpose, authorization, validation,
suppression and write-fence checks. The transaction context expires when the
body completes and refuses concurrent calls. It is not an HTTP operation or a
user-supplied function execution mechanism.

Sequential versioned updates can use the staged version from the preceding
operation. Lowering writes the final record once with the original durable
version precondition. Every logical audit and outbox event retains its own
operation ID and intermediate payload/version. With a validated read set, repeated updates can change unique/reference keys,
use non-versioned records, or include delete/restore. Lowering keeps the first
durable guard and the final record/claim changes, retaining every logical event.
Repeated temporal/hierarchy writes retain their separate guard protocol and
are rejected until dedicated structural lowering exists. Final parent creates
precede their referenced children; reference removals precede
parent deletion. Cycles requiring deferred constraints and reuse of a hard-deleted
identity are rejected.
An unhandled body failure, lowering rejection, provider conflict or budget
rejection leaves the group uncommitted. Application code must not publish an
external side effect from the body expecting it to roll back with storage.

At most 32 mutations and 32 resource snapshots are permitted. Each snapshot is
bounded to 4096 records and 64 adapter pages. Larger reads fail with
`BudgetExceeded`, including sparse DynamoDB scans; they never return partial
query results. Physical budgeting uses the fully lowered
plans, including all audit/outbox work, before commit. Sequence allocation,
credential sealing, per-operation receipt keys, functions, blob operations and
hierarchy operations are rejected. Declared functions have a separate opt-in described below; existing function
implementations retain their independent planning behavior.

Point reads, unique lookups, lists, dependent checks and temporal/hierarchy
planning reads use an invocation-local snapshot plus staged records. Lists use
the same filtering, byte ordering and cursor protocol as the reference adapter;
ordinary purpose projection and authorization remain in the engine. Soft-deleted
records remain available for restore planning and retained unique claims.

Every ordinary resource mutation now advances a tenant/resource revision in
`forge_document` (the DynamoDB document item uses `docVersion`). Non-tenant
resources use a shared revision. Snapshots capture that revision before reading
pages, and the final commit checks it atomically with all writes. An insertion,
update or deletion during or after the scan invalidates the transaction,
including empty predicates and missing point reads. This conservatively rejects
unrelated writes to the same resource. Read-only transactions validate without
creating a logical audit. No automatic body replay occurs after a conflict;
retry the whole body with application-level idempotency and external-effect care.

All writers must use the upgraded adapter before relying on these guarantees.
Old runtime instances, direct database writes and tools that bypass the adapter
do not advance resource revisions. The reserved document kind
`forge-resource-revision-v1` must not be changed by application document code.
Deploy a homogeneous writer version or hold the write fence during upgrade.
This source publication does not activate transactions in production consumers.

Memory, SQL and DynamoDB advertise `atomicComposition` and `atomicReadSet`.
DynamoDB folds shared parent counters into final entity writes and combines
revision CAS/increments into one item per resource. Incompatible duplicate
physical actions or guard shapes still fail closed, as do provider action/size
limits. Sequence allocation, credential sealing and transaction calls into
functions/blob/hierarchy mutation APIs remain excluded.

Local tests cover memory, SQLite and native libSQL. The provider verifier below
runs a separate named trace set against native PostgreSQL, hosted D1 and AWS
DynamoDB. Its scope is staged parent/child references and queries, phantom and
read-only conflicts, declared-function receipts and competing transactions;
it does not claim every application query or every structural mutation is
certified on every provider.

```sh
node scripts/verify-transaction-providers.mjs \
  --state-dir ~/.local/state/forgegraph/providers/20260930 \
  --provider all --receipt-dir /tmp/transaction-provider-receipts
```

The verifier reuses the private dedicated Foundation setup and its deployed core
bundle. It provisions nothing, creates isolated PostgreSQL schemas, and retains
only unique test tenants on hosted providers. An explicit
`FORGE_FOUNDATION_PG_URL` can select a disposable PostgreSQL instance instead of
the saved connection. Named assertions, identities, source/bundle digests and
failed receipts prevent skipped tests from being reported as certification.

## Declared functions

Opt an implementation into the same bounded transaction view explicitly:

```ts
defineFunction(
  "@acme/commerce/_/Compose",
  (deps) =>
    Effect.gen(function* () {
      const parent = yield* deps.resources.Customer!.create({
        code: "HQ",
        name: "HQ",
      });
      yield* deps.resources.Customer!.update(String(parent.id), 1, {
        name: "Headquarters",
      });
      return yield* deps.resources.Customer!.get(String(parent.id));
    }),
  { transactional: true },
);
```

The declaration still controls resource capabilities, transitions, external
bindings and allowed messages. Every mutation uses ordinary authorization,
scope, suppression and write-fence checks. The same snapshot bounds, revision guards and final-write
restrictions apply. Calls must execute sequentially and finish inside the body;
escaped resource, send and external Effects fail when executed later. A send
stages a message only when its Effect runs.

Lowered writes, logical audits, messages, the function's result receipt and any
subscription completion are budgeted together and committed once. A receipt-only
or message-only function also stores its actual result for replay when called
with an idempotency key. Unsupported adapters reject the invocation before the
body runs. Legacy implementations without the option keep their existing
planning behavior.

External bindings remain external side effects and cannot roll back with
storage. Subscription external-effect intent fencing remains in effect; it does
not make an arbitrary external service transactional. Tests cover memory, real
SQLite and native libSQL, including subscription completion and result replay. The provider verifier
adds the separate named live-database traces described above.
