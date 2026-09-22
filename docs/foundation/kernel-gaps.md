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

`functions.ts` readers currently call the engine directly while mutations append plans. A transaction read overlay is not established by the passing tests above. General stale read-set validation, read-your-writes, atomic sibling creation, and provider physical budgets remain separate required probes. The three green memory tests must not be reported as completion of those gates.

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
