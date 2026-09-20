import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req-1" };

let storage: MemoryStorage;
let engine: Engine;
const run = <A>(e: Effect.Effect<A, ForgeError, never>) => Effect.runPromise(e);
const fails = async <A>(e: Effect.Effect<A, ForgeError, never>): Promise<ForgeError> => {
  const exit = await Effect.runPromiseExit(e);
  if (exit._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(exit.value));
  const squashed = Cause.squash(exit.cause);
  if (squashed instanceof ForgeError) return squashed;
  throw new Error("unexpected cause: " + Cause.pretty(exit.cause));
};

beforeEach(() => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage));
});

describe("create", () => {
  it("applies normalizers, defaults, server-owned fields and returns the canonical record", async () => {
    const rec = await run(engine.call("@acme/commerce/_/Customer.create", { code: " acme ", name: "Acme" }, ctx));
    expect(rec).toEqual({ id: "cus_0001", version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null, code: "ACME", name: "Acme", email: null, tier: "standard" });
  });

  it("rejects unknown and server-owned fields with UnknownField", async () => {
    const e = await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme", version: 3, bogus: 1 }, ctx));
    expect(e.code).toBe("UnknownField");
    expect(e.fields?.map((f) => f.path).sort()).toEqual(["bogus", "version"]);
  });

  it("validates fields and reports every failure with a path and code", async () => {
    const e = await fails(engine.call("@acme/commerce/_/Customer.create", { code: "AB", name: "", email: 5, tier: "platinum" }, ctx));
    expect(e.code).toBe("ValidationFailed");
    expect(e.fields?.map((f) => [f.path, f.code])).toEqual([["code", "LengthOutOfRange"], ["name", "LengthOutOfRange"], ["email", "InvalidText"], ["tier", "InvalidEnumValue"]]);
  });

  it("enforces unique claims, including against soft-deleted records", async () => {
    const a = await run(engine.call("@acme/commerce/_/Customer.create", { code: "acme", name: "A" }, ctx));
    const dup = await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "B" }, ctx));
    expect(dup.code).toBe("UniqueConflict");
    expect(dup.constraint).toBe("@acme/commerce/_/Customer.unique.code");
    await run(engine.call("@acme/commerce/_/Customer.delete", { id: a.id, expectedVersion: 1 }, ctx));
    const stillDup = await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "C" }, ctx));
    expect(stillDup.code).toBe("UniqueConflict");
  });

  it("checks references exist in the same tenant", async () => {
    const missing = await fails(engine.call("@acme/commerce/_/Site.create", { customer: "cus_9999", code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    expect(missing.code).toBe("ReferenceMissing");
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    const cross = await fails(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, { ...ctx, tenant: "other" }));
    expect(cross.code).toBe("ReferenceMissing");
    const site = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    expect(site).toMatchObject({ customer: c.id, code: "HQ", enabled: true, version: 1 });
  });
});

describe("read, update, delete, restore", () => {
  it("get returns the record only within its tenant", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    expect(await run(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx))).toEqual(c);
    expect((await fails(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, { ...ctx, tenant: "other" }))).code).toBe("NotFound");
  });

  it("update requires the expected version, applies a patch, bumps version and updatedAt", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    const u = await run(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "B", email: "a@b.co" } }, ctx));
    expect(u).toMatchObject({ version: 2, name: "B", email: "a@b.co", code: "ACME" });
    expect(u.updatedAt > c.updatedAt).toBe(true);
    expect((await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "C" } }, ctx))).code).toBe("VersionConflict");
    expect((await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, patch: { name: "C" } }, ctx))).code).toBe("PreconditionRequired");
  });

  it("patch semantics: absent is unchanged, null clears an optional, immutable fields are rejected", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A", email: "a@b.co" }, ctx));
    const u = await run(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { email: null } }, ctx));
    expect(u.email).toBeNull();
    expect(u.name).toBe("A");
    const imm = await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 2, patch: { code: "NEW" } }, ctx));
    expect(imm.code).toBe("UnknownField");
    const req = await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 2, patch: { name: null } }, ctx));
    expect(req.code).toBe("ValidationFailed");
  });

  it("soft delete hides the record from get and list, restore brings it back, both guarded by version", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    const d = await run(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 1 }, ctx));
    expect(d.version).toBe(2);
    expect(d.deletedAt).not.toBeNull();
    expect((await fails(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx))).code).toBe("NotFound");
    expect((await fails(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 2 }, ctx))).code).toBe("AlreadyDeleted");
    const r = await run(engine.call("@acme/commerce/_/Customer.restore", { id: c.id, expectedVersion: 2 }, ctx));
    expect(r.version).toBe(3);
    expect(r.deletedAt).toBeNull();
    expect((await fails(engine.call("@acme/commerce/_/Customer.restore", { id: c.id, expectedVersion: 3 }, ctx))).code).toBe("NotDeleted");
  });
});

describe("queries", () => {
  it("find by a unique key returns zero-or-one after normalization", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "acme", name: "A" }, ctx));
    expect(await run(engine.call("@acme/commerce/_/Customer.find.byCode", { params: { code: " acme " } }, ctx))).toEqual(c);
    expect((await fails(engine.call("@acme/commerce/_/Customer.find.byCode", { params: { code: "nope" } }, ctx))).code).toBe("NotFound");
  });

  it("list by an equality key pages in declared order with an opaque cursor and a bounded limit", async () => {
    for (const [code, name, tier] of [["AAA", "Zed", "gold"], ["BBB", "Amy", "gold"], ["CCC", "Bob", "gold"], ["DDD", "Cat", "standard"]]) {
      await run(engine.call("@acme/commerce/_/Customer.create", { code, name, tier }, ctx));
    }
    const p1 = await run(engine.call("@acme/commerce/_/Customer.list.byTier", { params: { tier: "gold" }, limit: 2 }, ctx));
    expect(p1.items.map((i: any) => i.name)).toEqual(["Amy", "Bob"]);
    expect(p1.limit).toBe(2);
    expect(typeof p1.next).toBe("string");
    const p2 = await run(engine.call("@acme/commerce/_/Customer.list.byTier", { params: { tier: "gold" }, limit: 2, cursor: p1.next }, ctx));
    expect(p2.items.map((i: any) => i.name)).toEqual(["Zed"]);
    expect(p2.next).toBeNull();
    const bad = await fails(engine.call("@acme/commerce/_/Customer.list.byTier", { params: { tier: "gold" }, cursor: "nope" }, ctx));
    expect(bad.code).toBe("InvalidCursor");
    const other = await fails(engine.call("@acme/commerce/_/Customer.list.byTier", { params: { tier: "gold" }, cursor: p1.next }, { ...ctx, tenant: "other" }));
    expect(other.code).toBe("InvalidCursor");
    const capped = await run(engine.call("@acme/commerce/_/Customer.list.byTier", { params: { tier: "gold" }, limit: 500 }, ctx));
    expect(capped.limit).toBe(100);
  });
});

describe("idempotency", () => {
  it("replays the stored response for the same key and request, rejects a different request", async () => {
    const a = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, { ...ctx, idempotencyKey: "k1" }));
    const b = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, { ...ctx, idempotencyKey: "k1" }));
    expect(b).toEqual(a);
    expect((await storage.dump("acme"))["customer"]).toHaveLength(1);
    const mismatch = await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Different" }, { ...ctx, idempotencyKey: "k1" }));
    expect(mismatch.code).toBe("IdempotencyMismatch");
  });

  it("writes an audit row per committed mutation and nothing for a rejected one", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 9, patch: { name: "B" } }, ctx));
    const dump = await storage.dump("acme");
    expect(dump["audit"]!.map((a) => [a.kind, a.recordId, a.newVersion])).toEqual([["create", c.id, 1]]);
  });
});

describe("lifecycle transitions", () => {
  it("creation uses the initial state; exposed actions move the state under a version guard", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "HQ", name: "HQ", timezone: "UTC" }, ctx));
    const o = await run(engine.call("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.5", requestedOn: "2026-09-20" }, ctx));
    expect(o).toMatchObject({ status: "Draft", subtotal: "10.00", tax: "1.50", total: "11.50" });
    const cancelled = await run(engine.call("@acme/commerce/_/Order.status.cancel", { id: o.id, expectedVersion: 1, input: { reason: "changed mind" } }, ctx));
    expect(cancelled).toMatchObject({ status: "Cancelled", version: 2 });
    const again = await fails(engine.call("@acme/commerce/_/Order.status.approve", { id: o.id, expectedVersion: 2, input: {} }, ctx));
    expect(again.code).toBe("InvalidTransition");
  });

  it("row rules are enforced at commit: site must belong to the order's customer", async () => {
    const c1 = await run(engine.call("@acme/commerce/_/Customer.create", { code: "AAA", name: "A" }, ctx));
    const c2 = await run(engine.call("@acme/commerce/_/Customer.create", { code: "BBB", name: "B" }, ctx));
    const s2 = await run(engine.call("@acme/commerce/_/Site.create", { customer: c2.id, code: "HQ", name: "HQ", timezone: "UTC" }, ctx));
    const e = await fails(engine.call("@acme/commerce/_/Order.create", { customer: c1.id, site: s2.id, subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" }, ctx));
    expect(e.code).toBe("ValidationFailed");
    expect(e.fields?.[0]?.code).toBe("RuleViolation");
  });
});
