/**
 * M3 mutation integrity on the semantic model: outbox rows staged in the commit,
 * failed preconditions leave no audit/outbox, restrict-delete with dependents.
 */
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
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, ForgeError, never>) => Effect.runPromise(e);
const fails = async <A>(e: Effect.Effect<A, ForgeError, never>): Promise<ForgeError> => {
  const exit = await Effect.runPromiseExit(e);
  if (exit._tag === "Success") throw new Error("expected failure");
  const s = Cause.squash(exit.cause);
  if (s instanceof ForgeError) return s;
  throw new Error(Cause.pretty(exit.cause));
};

let storage: MemoryStorage;
let engine: Engine;
beforeEach(() => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage));
});

describe("outbox staging", () => {
  it("every committed mutation on an audited resource stages one outbox row per declared change event", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    await run(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "B" } }, ctx));
    const d = await storage.dump("acme");
    expect(d["outbox"]!.map((o) => [o.channel, o.message, o.payload.id, o.payload.version])).toEqual([
      ["@acme/commerce/_/Customer.changes", "Created", c.id, 1],
      ["@acme/commerce/_/Customer.changes", "Updated", c.id, 2],
    ]);
    expect(d["outbox"]![0].opId).toBe(d["audit"]![0].opId);
  });

  it("a failed precondition leaves no audit and no outbox row", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    await fails(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 5, patch: { name: "B" } }, ctx));
    await fails(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Dup" }, ctx));
    const d = await storage.dump("acme");
    expect(d["audit"]).toHaveLength(1);
    expect(d["outbox"]).toHaveLength(1);
  });
});

describe("restrict delete", () => {
  it("a parent with live dependents cannot be deleted; after the child is deleted it can", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    const blocked = await fails(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 1 }, ctx));
    expect(blocked.code).toBe("HasDependents");
    expect(blocked.detail).toContain("Site.customer");
    // Site has no @softDelete: delete is a hard delete
    const gone = await run(engine.call("@acme/commerce/_/Site.delete", { id: s.id, expectedVersion: 1 }, ctx));
    expect(gone).toMatchObject({ id: s.id });
    expect((await fails(engine.call("@acme/commerce/_/Site.get", { id: s.id }, ctx))).code).toBe("NotFound");
    const deleted = await run(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 1 }, ctx));
    expect(deleted.deletedAt).not.toBeNull();
  });

  it("a child cannot be created under a soft-deleted parent", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    await run(engine.call("@acme/commerce/_/Customer.delete", { id: c.id, expectedVersion: 1 }, ctx));
    const e = await fails(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
    expect(e.code).toBe("ReferenceMissing");
  });
});
