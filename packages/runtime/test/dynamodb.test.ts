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
    engine = new Engine(model, testLayer(new DynamoStorage({ table: table!, region: process.env["AWS_REGION"] ?? "us-east-1" }, model)));
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
