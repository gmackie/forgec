import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { Engine, type AtomicOptions } from "../src/engine.js";
import { Storage, type AtomicAbsenceGuard, type CommitPlan } from "../src/services.js";
import { DynamoStorage } from "../src/adapters/dynamodb.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { foundation, foundationAdapters } from "./helpers/foundation.js";

const p = "@forgegraph/foundation/allocation/_/";
const mutation = (key: string) => ({ operation: p + "AllocationPool.create", input: { key, mode: "exclusive", capacity: "1", unit: "slot" } });
const absent = (key: string): AtomicOptions => ({ absent: [{ resource: p + "AllocationPool", unique: "key", values: { key } }] });
const run = Effect.runPromise;

for (const adapter of foundationAdapters) {
  it(`${adapter}: absence is checked at commit after a competing fact is inserted`, async () => {
    const f = await foundation("allocation", adapter, true);
    try {
      const storage = await run(Storage.pipe(Effect.provide(f.engine.layer)));
      const commit = storage.commitAll.bind(storage);
      let injected = false;
      storage.commitAll = (plans, guards) => Effect.gen(function* () {
        if (guards?.length && !injected) {
          injected = true;
          yield* f.engine.call(mutation("revocation").operation, mutation("revocation").input, f.ctx);
        }
        yield* commit(plans, guards);
      });
      await expect(run(f.engine.atomic([mutation("assignment")], f.ctx, absent("revocation")))).rejects.toMatchObject({ code: "VersionConflict" });
      expect(injected).toBe(true);
      const rows = await f.call(p + "AllocationPool.list.all", {});
      expect(rows.items.map((row: { key: string }) => row.key)).toEqual(["revocation"]);
      // The same key in another tenant does not block the current tenant.
      await run(f.engine.atomic([mutation("assignment")], { ...f.ctx, tenant: "other" }, absent("revocation")));
    } finally { await f.close(); }
  });

  it(`${adapter}: mutually exclusive absence-guarded writes have exactly one winner`, async () => {
    const f = await foundation("allocation", adapter, true);
    try {
      const results = await Promise.allSettled([
        run(f.engine.atomic([mutation("left")], f.ctx, absent("right"))),
        run(f.engine.atomic([mutation("right")], f.ctx, absent("left"))),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect((await f.call(p + "AllocationPool.list.all", {})).items).toHaveLength(1);
    } finally { await f.close(); }
  });

  it(`${adapter}: same-group creation of a guarded key fails without writes`, async () => {
    const f = await foundation("allocation", adapter, true);
    try {
      await expect(run(f.engine.atomic([mutation("fact")], f.ctx, absent("fact")))).rejects.toMatchObject({ code: "ValidationFailed" });
      expect((await f.call(p + "AllocationPool.list.all", {})).items).toHaveLength(0);
    } finally { await f.close(); }
  });
}

it("fails closed on unsupported storage, invalid keys and denied guard reads", async () => {
  const f = await foundation("allocation", "memory", true);
  try {
    const storage = await run(Storage.pipe(Effect.provide(f.engine.layer)));
    Object.defineProperty(storage, "atomicAbsenceGuards", { value: false, configurable: true });
    await expect(run(f.engine.atomic([mutation("unsupported")], f.ctx, absent("fact")))).rejects.toMatchObject({ code: "ValidationFailed" });
    Object.defineProperty(storage, "atomicAbsenceGuards", { value: true });
    await expect(run(f.engine.atomic([mutation("bad")], f.ctx, { absent: [{ resource: p + "AllocationPool", unique: "key", values: {} }] }))).rejects.toThrow();
    await expect(run(f.engine.atomic([mutation("bad")], f.ctx, { absent: [{ resource: p + "Missing", unique: "key", values: { key: "a" } }] }))).rejects.toMatchObject({ code: "ValidationFailed" });
    const denied = new Engine(f.engine.model, f.engine.layer);
    denied.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: "writes", actions: [p + "AllocationPool.create"], requires: [], where: [] }], pips: [], epoch: 1, knownObligations: [] });
    await expect(run(denied.atomic([mutation("denied")], f.ctx, absent("fact")))).rejects.toMatchObject({ code: "NotPermitted" });
    denied.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: "filtered", actions: [p + "AllocationPool.*"], requires: [], where: [{ field: "key", op: "eq", values: ["visible"] }] }], pips: [], epoch: 2, knownObligations: [] });
    await expect(run(denied.atomic([mutation("visible")], f.ctx, absent("hidden")))).rejects.toMatchObject({ code: "NotPermitted" });
    expect((await f.call(p + "AllocationPool.list.all", {})).items).toHaveLength(0);
  } finally { await f.close(); }
});

it("requires guard query authority on purpose-scoped resources", async () => {
  const f = await foundation("allocation", "memory", true);
  try {
    const resource = f.engine.model.resource(p + "AllocationPool");
    resource.decorators.purposeScoped = true;
    await expect(run(f.engine.atomic([mutation("purpose")], { ...f.ctx, purpose: "missing-surface" }, absent("fact")))).rejects.toMatchObject({ code: "NotPermitted" });
  } finally { await f.close(); }
});

async function dynamoFixture() {
  const f = await foundation("allocation", "memory", true);
  const plan = await run(f.engine.planFor(mutation("assignment").operation, mutation("assignment").input, f.ctx).pipe(Effect.provide(f.engine.layer)));
  const resource = f.engine.model.resource(p + "AllocationPool"), unique = resource.uniques.find(u => u.name === "key")!;
  const values = { key: "revocation" };
  const guard: AtomicAbsenceGuard = { tenant: f.ctx.tenant, resource, unique, values, claimKey: f.engine.claimKey(resource, unique, values)! };
  const storage = new DynamoStorage({ table: "shape-only", region: "us-east-1" }, f.engine.model);
  const send = vi.fn(async (_command: { input: TransactWriteCommandInput }) => ({}));
  (storage as unknown as { doc: { send: typeof send } }).doc = { send };
  return { f, plan, guard, storage, send };
}

it("Dynamo checks the exact claim key in the write transaction and includes its budget", async () => {
  const { f, plan, guard, storage, send } = await dynamoFixture();
  try {
    await run(storage.commitAll([plan], [guard]));
    const items = send.mock.calls[0]![0].input.TransactItems!;
    const check = items.find(item => item.ConditionCheck)?.ConditionCheck;
    expect(check).toMatchObject({ TableName: "shape-only", ConditionExpression: "attribute_not_exists(PK)" });
    const guardedPlan: CommitPlan = { ...plan, after: { ...plan.after, key: "revocation" }, claims: [{ unique: guard.unique, before: null, after: guard.claimKey }] };
    send.mockClear();
    await run(storage.commitAll([guardedPlan]));
    const claim = send.mock.calls[0]![0].input.TransactItems!.find(item => item.Put?.Item?.entityId)?.Put?.Item;
    expect(check?.Key).toEqual({ PK: claim?.PK, SK: claim?.SK });
    expect(storage.budget([plan], [guard]).actions).toBe(items.length);
    expect(storage.budget([plan], [guard]).actions).toBe(storage.budget([plan]).actions + 1);
    send.mockClear();
    await expect(run(storage.commitAll([guardedPlan], [guard]))).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(send).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("Dynamo reports a condition failure without retrying or partially accepting", async () => {
  const { f, plan, guard, storage, send } = await dynamoFixture();
  try {
    send.mockImplementation(async command => {
      throw { name: "TransactionCanceledException", CancellationReasons: command.input.TransactItems!.map(item => ({ Code: item.ConditionCheck ? "ConditionalCheckFailed" : "None" })) };
    });
    await expect(run(storage.commitAll([plan], [guard]))).rejects.toMatchObject({ code: "VersionConflict" });
    expect(send).toHaveBeenCalledTimes(1);
  } finally { await f.close(); }
});
