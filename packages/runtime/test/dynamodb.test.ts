/**
 * DynamoDB adapter against a real table. Enabled with FORGE_DYNAMO_TABLE
 * (created on demand, on-demand billing). The same engine scenarios that
 * pass on the memory adapter must pass here; the adapter, not the engine,
 * is under test.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { DynamoStorage, ensureDynamoTable } from "../src/adapters/dynamodb.js";
import { testLayer } from "../src/testing.js";

const table = process.env["FORGE_DYNAMO_TABLE"];
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const run = <A>(e: Effect.Effect<A, ForgeError, never>) => Effect.runPromise(e);
const fails = async <A>(e: Effect.Effect<A, ForgeError, never>): Promise<ForgeError> => {
  const exit = await Effect.runPromiseExit(e);
  if (exit._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(exit.value));
  const s = Cause.squash(exit.cause);
  if (s instanceof ForgeError) return s;
  throw new Error("unexpected cause: " + Cause.pretty(exit.cause));
};

describe.skipIf(!table)("DynamoDB adapter (live)", () => {
  let engine: Engine;
  let ctx: { tenant: string; actor: string; requestId: string; idempotencyKey?: string };
  beforeAll(async () => {
    await ensureDynamoTable(table!, process.env["AWS_REGION"] ?? "us-east-1");
    engine = new Engine(model, testLayer(new DynamoStorage({ table: table!, region: process.env["AWS_REGION"] ?? "us-east-1" }, model), { runId: randomUUID().slice(0, 8) }));
    ctx = { tenant: `t-${randomUUID().slice(0, 8)}`, actor: "operator", requestId: "r" };
  }, 300_000);

  it("create/get/update/delete/restore with claims and audit", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: " acme ", name: "Acme" }, ctx));
    expect(c).toMatchObject({ version: 1, code: "ACME", tier: "standard", deletedAt: null });
    expect(await run(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx))).toEqual(c);
    expect((await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Dup" }, ctx))).code).toBe("UniqueConflict");
    const u = await run(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "B", tier: "gold" } }, ctx));
    expect(u).toMatchObject({ version: 2, name: "B", tier: "gold" });
    expect((await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "C" } }, ctx))).code).toBe("VersionConflict");
    expect(await run(engine.call("@acme/commerce/_/Customer.find.byCode", { params: { code: "acme" } }, ctx))).toMatchObject({ id: c.id, version: 2 });
    const d = await run(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 2 }, ctx));
    expect(d.deletedAt).not.toBeNull();
    expect((await fails(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx))).code).toBe("NotFound");
    expect((await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Again" }, ctx))).code).toBe("UniqueConflict");
    const r = await run(engine.call("@acme/commerce/_/Customer.restore", { id: c.id, expectedVersion: 3 }, ctx));
    expect(r).toMatchObject({ version: 4, deletedAt: null });
  }, 60_000);

  it("references are guarded in the transaction; list uses strong access items in declared order", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "REF1", name: "Ref" }, ctx));
    expect((await fails(engine.call("@acme/commerce/_/Site.create", { customer: "cus_nope", code: "hq", name: "HQ", timezone: "UTC" }, ctx))).code).toBe("ReferenceMissing");
    for (const [code, name] of [["hq", "HQ"], ["an", "Annex"], ["zz", "Zeta"]]) {
      await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code, name, timezone: "UTC" }, ctx));
    }
    const p1 = await run(engine.call("@acme/commerce/_/Site.list.byCustomer", { params: { customer: c.id }, limit: 2 }, ctx));
    expect(p1.items.map((i: any) => i.name)).toEqual(["Annex", "HQ"]);
    const p2 = await run(engine.call("@acme/commerce/_/Site.list.byCustomer", { params: { customer: c.id }, limit: 2, cursor: p1.next }, ctx));
    expect(p2.items.map((i: any) => i.name)).toEqual(["Zeta"]);
    expect(p2.next).toBeNull();
    // rename moves the access item; a stale rename does not
    const hq = p1.items[1]!;
    await run(engine.call("@acme/commerce/_/Site.update", { id: hq.id, expectedVersion: 1, patch: { name: "Alpha" } }, ctx));
    await fails(engine.call("@acme/commerce/_/Site.update", { id: hq.id, expectedVersion: 1, patch: { name: "Stale" } }, ctx));
    const all = await run(engine.call("@acme/commerce/_/Site.list.byCustomer", { params: { customer: c.id } }, ctx));
    expect(all.items.map((i: any) => [i.name, i.version])).toEqual([["Alpha", 2], ["Annex", 1], ["Zeta", 1]]);
  }, 60_000);

  it("descending order with tie-breaker and idempotent replay", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ORD1", name: "Ord" }, ctx));
    const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await run(engine.call("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "1.00", tax: "0.10", requestedOn: "2026-09-20" }, ctx));
      ids.push(o.id);
    }
    const page = await run(engine.call("@acme/commerce/_/Order.list.byCustomer", { params: { customer: c.id }, limit: 2 }, ctx));
    expect(page.items.map((i: any) => i.id)).toEqual([ids[2], ids[1]]);
    const rest = await run(engine.call("@acme/commerce/_/Order.list.byCustomer", { params: { customer: c.id }, limit: 2, cursor: page.next }, ctx));
    expect(rest.items.map((i: any) => i.id)).toEqual([ids[0]]);
    const k = { ...ctx, idempotencyKey: randomUUID() };
    const a = await run(engine.call("@acme/commerce/_/Customer.create", { code: "IDEM1", name: "I" }, k));
    const b = await run(engine.call("@acme/commerce/_/Customer.create", { code: "IDEM1", name: "I" }, k));
    expect(b).toEqual(a);
    expect((await fails(engine.call("@acme/commerce/_/Customer.create", { code: "IDEM1", name: "J" }, k))).code).toBe("IdempotencyMismatch");
  }, 60_000);

  it("concurrent same-version updates admit exactly one winner", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "RACE1", name: "Race" }, ctx));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => Effect.runPromiseExit(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: `W${i}` } }, ctx))));
    const wins = results.filter((r) => r._tag === "Success").length;
    const codes = results.filter((r) => r._tag === "Failure").map((r) => (Cause.squash((r as any).cause) as ForgeError).code);
    expect(wins).toBe(1);
    expect(new Set(codes)).toEqual(new Set(["VersionConflict"]));
    expect((await run(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx))).version).toBe(2);
  }, 60_000);
});

describe.skipIf(!table)("DynamoDB adapter (live) — M3 integrity", () => {
  let engine: Engine;
  let ctx: { tenant: string; actor: string; requestId: string };
  beforeAll(async () => {
    engine = new Engine(model, testLayer(new DynamoStorage({ table: table!, region: process.env["AWS_REGION"] ?? "us-east-1" }, model), { runId: randomUUID().slice(0, 8) }));
    ctx = { tenant: `t-${randomUUID().slice(0, 8)}`, actor: "operator", requestId: "r" };
  });

  it("restrict-delete via dependent counters, hard delete of a child, delete racing child creates", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "PAR1", name: "Parent" }, ctx));
    const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    expect((await fails(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 1 }, ctx))).code).toBe("HasDependents");
    await run(engine.call("@acme/commerce/_/Site.delete", { id: s.id, expectedVersion: 1 }, ctx));
    expect((await fails(engine.call("@acme/commerce/_/Site.get", { id: s.id }, ctx))).code).toBe("NotFound");
    expect(await run(engine.call("@acme/commerce/_/Site.list.byCustomer", { params: { customer: c.id } }, ctx))).toMatchObject({ items: [] });
    // race: delete vs 4 child creates — never an orphan
    const [del, ...creates] = await Promise.all([
      Effect.runPromiseExit(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 1 }, ctx)),
      ...["r1", "r2", "r3", "r4"].map((code) => Effect.runPromiseExit(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code, name: code, timezone: "UTC" }, ctx))),
    ]);
    const created = creates.filter((r) => r._tag === "Success").length;
    const parent = await Effect.runPromiseExit(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx));
    if (del._tag === "Success") {
      expect(created).toBe(0);
      expect(parent._tag).toBe("Failure"); // soft-deleted => NotFound
    } else {
      expect(created).toBeGreaterThan(0);
      expect(parent._tag).toBe("Success");
      const listed = await run(engine.call("@acme/commerce/_/Site.list.byCustomer", { params: { customer: c.id } }, ctx));
      expect(listed.items).toHaveLength(created);
    }
  }, 60_000);
});

describe.skipIf(!table)("DynamoDB adapter (live) — M5 dispatch", () => {
  it("sweep/claim/progress/complete over the sparse index, dead-letter and redrive, consumer dedup", async () => {
    const { Dispatcher } = await import("../src/dispatch.js");
    const storage = new DynamoStorage({ table: table!, region: process.env["AWS_REGION"] ?? "us-east-1" }, model);
    const engine = new Engine(model, testLayer(storage, { runId: randomUUID().slice(0, 8) }));
    const tenant = `t-${randomUUID().slice(0, 8)}`;
    const c = { tenant, actor: "operator", requestId: "r" };
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "DISP", name: "D" }, c));
    const sent: string[] = [];
    let fail = true;
    const transport = { name: "t", send: (d: any) => (fail && d.subscription === "b" ? Effect.fail(new Error("down")) : Effect.sync(() => void sent.push(`${d.subscription}:${d.envelope.messageId}`))) };
    const dispatcher = new Dispatcher(model, storage, transport, { subscriptions: { "@acme/commerce/_/Customer.changes": ["a", "b"] }, leaseMs: 100, maxAttempts: 2 });
    // the sparse index is eventually consistent: wait for the row to appear
    let r = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
    for (let i = 0; i < 20 && r.claimed === 0; i++) {
      r = await Effect.runPromise(dispatcher.sweep(tenant, { now: Date.now() }));
      if (r.claimed === 0) await new Promise((res) => setTimeout(res, 300));
    }
    expect(r).toEqual({ claimed: 1, delivered: 1, failed: 1, dead: 0 });
    await new Promise((res) => setTimeout(res, 150)); // lease expiry
    let r2 = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
    for (let i = 0; i < 20 && r2.claimed === 0; i++) {
      r2 = await Effect.runPromise(dispatcher.sweep(tenant, { now: Date.now() }));
      if (r2.claimed === 0) await new Promise((res) => setTimeout(res, 300));
    }
    expect(r2).toEqual({ claimed: 1, delivered: 0, failed: 1, dead: 1 }); // `a` not repeated; `b` fails again -> dead
    let dead = await Effect.runPromise(dispatcher.dead(tenant));
    for (let i = 0; i < 20 && dead.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 300));
      dead = await Effect.runPromise(dispatcher.dead(tenant));
    }
    expect(dead.map((d) => [d.status, d.attempts, d.delivered])).toEqual([["dead", 2, ["a"]]]);
    fail = false;
    expect(await Effect.runPromise(dispatcher.redrive(tenant, dead[0]!.opId, 0))).toBe(true);
    let r3 = { claimed: 0, delivered: 0, failed: 0, dead: 0 };
    for (let i = 0; i < 20 && r3.claimed === 0; i++) {
      r3 = await Effect.runPromise(dispatcher.sweep(tenant, { now: Date.now() }));
      if (r3.claimed === 0) await new Promise((res) => setTimeout(res, 300));
    }
    expect(r3).toEqual({ claimed: 1, delivered: 1, failed: 0, dead: 0 });
    expect(sent.map((s) => s.split(":")[0])).toEqual(["a", "b"]);
    const consumer = dispatcher.consumer("b", async () => {});
    const env = { channel: "c", message: "M", tenant, opId: "x", ordinal: 0, messageId: "x:0", payload: {}, createdAt: "t" };
    expect([await consumer(env), await consumer(env)]).toEqual(["processed", "duplicate"]);
  }, 120_000);
});
