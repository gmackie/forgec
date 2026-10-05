import { Effect } from "effect";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { foundation } from "./helpers/foundation.js";
import { DynamoStorage } from "../src/adapters/dynamodb.js";
import type { CommitPlan } from "../src/services.js";

type TxItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
let fixture: Awaited<ReturnType<typeof foundation>>;
let plans: CommitPlan[];
let poolPlan: CommitPlan;
const prefix = "@forgegraph/foundation/allocation/_/";
beforeAll(async () => {
  fixture = await foundation("allocation", "memory", true);
  const plan = (operation: string, input: Record<string, unknown>) => Effect.runPromise(
    fixture.engine.planFor(prefix + operation, input, fixture.ctx).pipe(Effect.provide(fixture.engine.layer)));
  poolPlan = await plan("AllocationPool.create", { key: "composition", mode: "exclusive", capacity: "1", unit: "slot" });
  const pool = await fixture.call(prefix + "AllocationPool.create", { key: "durable", mode: "exclusive", capacity: "1", unit: "slot" });
  plans = await Promise.all(["one", "two", "three"].map(key => plan("AllocationReservation.create", {
    pool: pool.id, key, quantity: "1", unit: "slot", from: "2026-01-02T00:00:00Z",
    until: "2026-01-03T00:00:00Z", holdUntil: "2026-01-01T12:00:00Z",
  })));
});
afterAll(async () => { await fixture?.close(); });

function capture(softDeleteParents = false) {
  const model = Object.create(fixture.engine.model) as typeof fixture.engine.model;
  if (softDeleteParents) model.resource = id => {
    const resource = fixture.engine.model.resource(id);
    return { ...resource, decorators: { ...resource.decorators, softDelete: true } };
  };
  const storage = new DynamoStorage({ table: "shape-only", region: "us-east-1" }, model);
  const send = vi.fn(async (_command: { input: TransactWriteCommandInput }) => ({}));
  (storage as unknown as { doc: { send: typeof send } }).doc = { send };
  return { storage, send };
}
function key(item: TxItem) {
  const action = item.Put ?? item.Update ?? item.Delete ?? item.ConditionCheck;
  const target = item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key ?? item.ConditionCheck?.Key;
  return JSON.stringify([action?.TableName, target?.PK, target?.SK]);
}

it("coalesces three shared-parent increments and budgets the actual physical transaction", async () => {
  const { storage, send } = capture();
  const withOutbox = plans.map(plan => ({ ...plan, outbox: [{ tenant: plan.tenant, opId: plan.opId,
    ordinal: 0, channel: "test", message: "created", payload: {}, createdAt: plan.at }] }));
  await Effect.runPromise(storage.commitAll(withOutbox));
  const items = send.mock.calls[0]![0].input.TransactItems!;
  expect(new Set(items.map(key)).size).toBe(items.length);
  expect(storage.budget(withOutbox)).toEqual({ actions: items.length, limit: 100 });
  expect(storage.budget(withOutbox).actions - storage.budget(plans).actions).toBe(4);
  const counters = items.filter(item => item.Update?.UpdateExpression?.startsWith("ADD "));
  expect(counters).toHaveLength(1);
  const update = counters[0]!.Update!;
  expect(update.ExpressionAttributeValues![":sum0"]).toBe(3);
  expect(update.ConditionExpression?.match(/attribute_exists\(PK\)/g)).toHaveLength(3);
  const expression = update.UpdateExpression + " " + update.ConditionExpression;
  const bindings = { ...update.ExpressionAttributeNames, ...update.ExpressionAttributeValues };
  expect(new Set(expression.match(/#[A-Za-z0-9_]+|:[A-Za-z0-9_]+/g))).toEqual(new Set(Object.keys(bindings)));
});

it("preserves distinct counter fields and soft-delete guards", async () => {
  const { storage, send } = capture(true);
  const guarded = plans.slice(0, 2).map((plan, index) => ({ ...plan,
    resource: { ...plan.resource, id: plan.resource.id + index },
    references: plan.references.map(reference => ({ ...reference,
      resource: { ...reference.resource, decorators: { ...reference.resource.decorators, softDelete: true } } })),
  }));
  await Effect.runPromise(storage.commitAll(guarded));
  const update = send.mock.calls[0]![0].input.TransactItems!.find(item => item.Update?.UpdateExpression?.startsWith("ADD "))!.Update!;
  expect(Object.values(update.ExpressionAttributeNames!).filter(name => name.startsWith("dep#"))).toHaveLength(2);
  expect(update.ConditionExpression?.match(/deletedAt = /g)).toHaveLength(2);
  for (const token of update.ConditionExpression!.match(/:[A-Za-z0-9_]+/g)!) expect(update.ExpressionAttributeValues![token]).toBeNull();
});

it("rejects a parent entity write colliding with a reference counter before sending", async () => {
  const { storage, send } = capture();
  const parentId = plans[0]!.after.pool as string;
  await expect(Effect.runPromise(storage.commitAll([{ ...poolPlan, id: parentId }, plans[0]!]))).rejects.toMatchObject({ code: "ValidationFailed" });
  expect(send).not.toHaveBeenCalled();
});

it("rejects competing unique claims before sending", async () => {
  const { storage, send } = capture();
  const duplicate = { ...plans[1]!, after: { ...plans[1]!.after, key: plans[0]!.after.key } };
  await expect(Effect.runPromise(storage.commitAll([plans[0]!, duplicate]))).rejects.toMatchObject({ code: "ValidationFailed" });
  expect(send).not.toHaveBeenCalled();
});

it("rejects the transaction limit including its tenant marker", async () => {
  const { storage, send } = capture();
  const base = plans[0]!;
  const publish = { ...base, kind: "publish" as const, outbox: Array.from({ length: 99 }, (_, ordinal) => ({
    tenant: base.tenant, opId: base.opId, ordinal, channel: "test", message: "created", payload: {}, createdAt: base.at,
  })) };
  expect(storage.budget([publish]).actions).toBe(101);
  await expect(Effect.runPromise(storage.commitAll([publish]))).rejects.toMatchObject({ code: "BudgetExceeded" });
  expect(send).not.toHaveBeenCalled();
});

it("classifies a failed merged parent condition as ReferenceMissing", async () => {
  const { storage, send } = capture();
  send.mockImplementation(async command => {
    throw { name: "TransactionCanceledException", CancellationReasons: command.input.TransactItems!.map(item => ({
      Code: item.Update?.UpdateExpression?.startsWith("ADD ") ? "ConditionalCheckFailed" : "None",
    })) };
  });
  await expect(Effect.runPromise(storage.commitAll(plans))).rejects.toMatchObject({ code: "ReferenceMissing" });
  expect(send).toHaveBeenCalledTimes(1);
});
