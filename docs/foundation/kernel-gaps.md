# Foundation atomicity baseline and unresolved gates

Observed on 2026-09-22 against runtime source from `36dccaa30d24ac4e70f8032b9f7bbca27f57dfe8`, using the existing compiled `conformance/fixtures/acme.app.json` and the memory adapter. These are kernel prerequisites, not Foundation implementation or provider certification. Customer records serve only as version guards and posting-like writes; no capacity arithmetic, currency balancing or Foundation schema is exercised.

## Supported memory guarantees

`packages/runtime/test/foundation-atomicity.test.ts` contains three passing regressions:

- Two contenders plan from the same version before either commits. Exactly one guarded group commits; the loser's earlier-created claim and audit disappear.
- A conflict on the final plan rolls back both earlier posting-like records and all observable state. Reusing their unique codes proves unique claims also rolled back.
- Two updates of the same record, both expecting version 1, reject with `VersionConflict` and leave version 1 and all prior state intact. They do not silently lose a write.

Run from repository root:

```sh
pnpm --filter @forgegraph/runtime exec vitest run test/foundation-atomicity.test.ts
```

This verifies deterministic competing stale plans, not multithreaded or distributed contention. The single-threaded memory adapter applies `commitAll` plans synchronously and restores its snapshot on failure. D1, PostgreSQL and DynamoDB require separate real-provider tests with transaction-budget, foreign-key and concurrent-commit cases.

## Blocked: staged parent references

Update: the explicit experimental `Engine.transaction` API now stages parent
and child creation with point-read overlays. Memory/SQLite/libSQL regressions
cover atomic publication and rollback; see [transactions](../transactions.md).
The original standalone `planFor` and legacy function-body reproductions below retain
their historical limitations. Query overlays and conservative resource-revision read-set guards are now
implemented. Named provider traces cover native PostgreSQL, hosted D1 and AWS
DynamoDB; see the scoped transaction verification below.

Desired invariant: a single transaction can create an aggregate and its referenced child without an intermediate committed parent. The current Engine validates child references against durable storage during `planFor`, before either plan reaches `commitAll`.

Minimal reproduction, using the helpers and fixture in the regression test above:

```ts
it("creates a staged parent and referenced child atomically", async () => {
  const parent = await plan(`${customer}.create`, { code: "PARENT", name: "parent" });
  const child = await plan("@acme/commerce/_/Site.create", {
    customer: parent.id, code: "HQ", name: "HQ", timezone: "UTC",
  });
  await run(storage.commitAll([parent, child]));
  expect(await get(parent.id)).toMatchObject({ id: parent.id });
});
```

This probe was executed and **failed**, with `ReferenceMissing`, `referenced record not found: customer`, at `packages/runtime/src/engine.ts:362`. It is recorded here rather than marked as an expected failure in a green acceptance suite. Aggregate-plus-child creation remains a blocked gate.

The kernel needs a transaction-local view that resolves staged records during reference validation, while retaining race-safe commit-time validation for durable references and deletes. The provider lowering must preserve atomicity and enforce transaction limits. Committing the parent first would weaken the required invariant and is not an acceptable workaround.

## Blocked: sequential same-record updates

Update: `Engine.transaction` supports bounded repeated versioned updates with
stable unique/reference keys. It consolidates physical record writes and retains
the first durable guard and every logical audit/outbox event. The broader
composition and provider gates below remain open outside that explicit API.

Desired invariant for transaction composition: the second operation sees the first staged record/version. Current planning validates each update independently against committed state.

```ts
it("updates the staged version in a second operation", async () => {
  const record = await create("GUARD");
  const first = await plan(`${customer}.update`, {
    id: record.id, expectedVersion: 1, patch: { name: "first" },
  });
  const second = await plan(`${customer}.update`, {
    id: record.id, expectedVersion: 2, patch: { name: "second" },
  });
  await run(storage.commitAll([first, second]));
  expect(await get(record.id)).toMatchObject({ version: 3, name: "second" });
});
```

This probe was executed and **failed**, with `VersionConflict`, `expected version 2, current is 1`, at `packages/runtime/src/engine.ts:397`. Changing the second expected version to 1 does not fix composition: planning succeeds but the supported regression demonstrates the group then rejects atomically at commit.

For the current substrate algorithms, calculate one final update per pool/account guard and include it once in the group. This does not claim sequential mutation support. A kernel implementation of sequential composition must define transaction-local reads, consolidate repeated provider writes while retaining original durable preconditions, and preserve the intended intermediate validation/audit behavior. It must not blindly drop one of the plans or weaken expected-version checks. Provider tests must cover duplicate physical keys and guarded references before this gate is accepted.

## Remaining limits

Declared functions can now explicitly opt in with `defineFunction(id, body,
{ transactional: true })`. Their point reads and references use the transaction
view, and lowered writes, messages, result receipts and subscription completion
share a budgeted atomic commit. Tests cover staged updates/references and
subscription completion on memory, SQLite and native libSQL, plus result replay,
rollback, authorization, budget rejection and expired/concurrent calls. Legacy
functions still plan against committed state. Resource snapshots now cover predicates and missing reads, with revision guards
checked in the atomic commit. Repeated mutations can change keys/references or
include deletes/restores; DynamoDB composes entity/counter and revision actions.
Verification runs a named live-provider trace set alongside local regression
coverage. Snapshot size, cyclic references and incompatible physical action
limits remain explicit; see [transactions](../transactions.md).

## Implemented since the baseline: immutable facts and sealed content

`@appendOnly` removes resource update/delete/restore/transition operations; runtime
checks also reject injected mutation operations. `@writeOnce` blobs accept upload
attempts until sealed and then reject reuploads, metadata updates and deletion.
Changing either annotation produces a compatibility migration finding. Dedicated
compiler tests and generated-package memory/SQLite tests exercise these invariants.
Direct adapters and administrative migration tooling remain trusted boundaries.

Blob finalization now hashes an isolated sealed copy. Reproduced races previously
allowed digest/content mismatch and losing finalizers to overwrite winning bytes;
both have passing regressions. Legacy object keys remain readable. These fixes do
not establish general transaction read overlays or live provider certification.

## Bounded authorized atomic mutations

Engine.atomic accepts 1–32 independent operation/input descriptors against durable references. It uses normal purpose scoping and result projection, append-only/write-once checks, Gatekeeper before/candidate authorization, write fencing and suppression. Provider budgets are checked before one commitAll. Sequence allocation, credential sealing, receipt idempotency keys and repeated writes to one record are explicitly rejected. Scheduling uses durable command/publication facts for retries and one combined Allocation journal replacement per pool. Generated memory/SQLite/PostgreSQL tests prove rollback on a late conflict; scope/fence/suppression/budget tests cover the ordinary protected surfaces. General staged references, sequential same-record changes and read-set overlays remain unsupported.

## Decimal validation correction

Exclusive integer/decimal/money field bounds now reject their endpoints. Rule comparison resolves decimal types through declared reference fields and uses exact common-scale BigInt ordering, including equality with numeric literals. Numeric-looking text retains lexical ordering. Regressions reproduced both original failures before correction.

## Adapter audit fixes

MemoryStorage now rejects a duplicate idempotency receipt before mutating any records, audit or outbox state; the losing command retries against the winning receipt. A forced concurrent-miss regression proves one business effect. DynamoDB atomic assembly coalesces compatible shared-parent reference counters while preserving each guard, rejects incompatible duplicate physical targets before sending, and includes per-tenant outbox markers in the provider action budget. Request-shape tests do not substitute for live DynamoDB certification.

## Bounded serializable absence guards

`Engine.atomic(mutations, ctx, { absent: [{ resource, unique, values }] })`
accepts at most 32 unique-key absence guards over append-only resources with
unconditional unique finders. Values pass normal decoding, purpose filtering and
unfiltered read authorization. Tenant comes from the call context. Row-filtered
or denied read authority, null/incomplete keys, conditional uniqueness, unsupported
adapters and a group that creates its own forbidden fact fail closed.

Memory checks claim absence synchronously with commit; SQL checks `NOT EXISTS`
inside the same assertion batch (PostgreSQL uses SERIALIZABLE transactions);
DynamoDB adds claim-key ConditionChecks. Guard actions count toward provider
budgets. Conflicts roll back all business effects. These are bounded unique-key
guards, not arbitrary predicate reads or a staged-record overlay.

The kernel suite and Routing tests pass with memory, SQLite and PostgreSQL17.
Routing injects qualification revocation and membership termination between final
validation and atomic commit and proves no assignment, accepted outcome or
capacity debit survives. Existing future-effective terminal facts are immutable and
can remain eligible for an earlier interval. Dynamo request-shape tests exercise
guard lowering and budgeting; hosted certification remains separate.

## Transaction read-set and provider verification

`TransactionView` now evaluates bounded complete resource snapshots, including
staged writes, through the reference query evaluator. A revision read before the
scan is checked inside the final provider commit, detecting phantoms, stale point
reads and competing groups. Ordinary adapter commits advance the same revision;
legacy or raw database writers must be fenced/upgraded before activation.

`node scripts/verify-transaction-providers.mjs` executes five named traces against
existing dedicated PostgreSQL/D1/DynamoDB targets and emits source-bound receipts.
The traces cover staged parent references/queries, predicate phantom rollback,
read-only validation, function receipt replay and competing commits. This is a
bounded experimental transaction contract, not blanket provider certification
for all application patterns. See [transactions](../transactions.md) for limits
and the exact invocation.
