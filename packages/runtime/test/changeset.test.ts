/**
 * Changesets (plan §9, §12): one mutation model for bulk edits. Propose N
 * operations, preview (per-op validation + diff + physical budget), commit
 * atomically within the budget or resumably per record.
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
  if (exit._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(exit.value));
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

const CS = "@acme/commerce/_/changesets";

describe("changeset lifecycle", () => {
  it("propose -> preview shows per-operation diffs, errors, and the atomic budget", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme" }, ctx));
    const cs = await run(engine.call(`${CS}.propose`, { operations: [
      { op: "@acme/commerce/_/Customer.update", input: { id: c.id, expectedVersion: 1, patch: { name: "Acme Inc" } } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "beta", name: "Beta" } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "x", name: "" } },
    ] }, ctx));
    expect(cs).toMatchObject({ status: "proposed", operations: 3 });
    const preview = await run(engine.call(`${CS}.preview`, { id: cs.id }, ctx));
    expect(preview.status).toBe("previewed");
    expect(preview.items.map((i: any) => i.status)).toEqual(["ok", "ok", "error"]);
    expect(preview.items[0].diff).toEqual([{ path: "name", before: "Acme", after: "Acme Inc" }]);
    expect(preview.items[1].diff.find((d: any) => d.path === "code")).toEqual({ path: "code", before: null, after: "BETA" });
    expect(preview.items[2].error.code).toBe("ValidationFailed");
    expect(preview.budget).toMatchObject({ mode: "resumable", logicalLimit: 10, physicalActions: expect.any(Number), atomicAllowed: false }); // default mode is resumable (plan §13)
    expect(typeof preview.contentHash).toBe("string");
  });

  it("commit refuses an un-approved or invalid changeset; approval binds the content hash", async () => {
    const cs = await run(engine.call(`${CS}.propose`, { operations: [{ op: "@acme/commerce/_/Customer.create", input: { code: "x", name: "" } }] }, ctx));
    await run(engine.call(`${CS}.preview`, { id: cs.id }, ctx));
    expect((await fails(engine.call(`${CS}.commit`, { id: cs.id }, ctx))).code).toBe("InvalidTransition");
    const ok = await run(engine.call(`${CS}.propose`, { operations: [{ op: "@acme/commerce/_/Customer.create", input: { code: "GOOD", name: "Good" } }] }, ctx));
    const p = await run(engine.call(`${CS}.preview`, { id: ok.id }, ctx));
    expect((await fails(engine.call(`${CS}.approve`, { id: ok.id, contentHash: "stale" }, ctx))).code).toBe("VersionConflict");
    await run(engine.call(`${CS}.approve`, { id: ok.id, contentHash: p.contentHash }, ctx));
    const committed = await run(engine.call(`${CS}.commit`, { id: ok.id }, ctx));
    expect(committed.status).toBe("committed");
    expect(committed.results[0]).toMatchObject({ status: "committed", result: { code: "GOOD" } });
  });

  it("atomic mode: all or nothing, and re-checks revisions at commit", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme" }, ctx));
    const cs = await run(engine.call(`${CS}.propose`, { mode: "atomic", operations: [
      { op: "@acme/commerce/_/Customer.update", input: { id: c.id, expectedVersion: 1, patch: { name: "A2" } } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "beta", name: "Beta" } },
    ] }, ctx));
    const p = await run(engine.call(`${CS}.preview`, { id: cs.id }, ctx));
    expect(p.budget.atomicAllowed).toBe(true);
    await run(engine.call(`${CS}.approve`, { id: cs.id, contentHash: p.contentHash }, ctx));
    // someone else moves the record between approval and commit
    await run(engine.call("@acme/commerce/_/Customer.update", { id: c.id, expectedVersion: 1, patch: { name: "Moved" } }, ctx));
    const failed = await run(engine.call(`${CS}.commit`, { id: cs.id }, ctx));
    expect(failed.status).toBe("failed");
    expect(failed.results.map((r: any) => r.status)).toEqual(["error", "skipped"]);
    expect(failed.results[0].error.code).toBe("VersionConflict");
    // nothing persisted from the changeset
    expect((await fails(engine.call("@acme/commerce/_/Customer.find.byCode", { params: { code: "BETA" } }, ctx))).code).toBe("NotFound");
    const d = await storage.dump("acme");
    expect(d["audit"]!.filter((a) => a.kind === "create")).toHaveLength(1);
  });

  it("resumable mode: per-record results, later records commit even if an earlier one fails, and commit is re-entrant", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Acme" }, ctx));
    const cs = await run(engine.call(`${CS}.propose`, { mode: "resumable", operations: [
      { op: "@acme/commerce/_/Customer.update", input: { id: c.id, expectedVersion: 9, patch: { name: "Stale" } } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "beta", name: "Beta" } },
      { op: "@acme/commerce/_/Customer.create", input: { code: "gamma", name: "Gamma" } },
    ] }, ctx));
    const p = await run(engine.call(`${CS}.preview`, { id: cs.id }, ctx));
    expect(p.items.map((i: any) => i.status)).toEqual(["error", "ok", "ok"]);
    // resumable commits proceed past preview errors (they are reported per row)
    await run(engine.call(`${CS}.approve`, { id: cs.id, contentHash: p.contentHash }, ctx));
    const first = await run(engine.call(`${CS}.commit`, { id: cs.id }, ctx));
    expect(first.status).toBe("partially-committed");
    expect(first.results.map((r: any) => r.status)).toEqual(["error", "committed", "committed"]);
    const again = await run(engine.call(`${CS}.commit`, { id: cs.id }, ctx));
    expect(again.results.map((r: any) => r.status)).toEqual(["error", "committed", "committed"]);
    expect((await run(engine.call("@acme/commerce/_/Customer.list.byTier", { params: { tier: "standard" } }, ctx))).items).toHaveLength(3);
  });

  it("atomic mode is refused beyond the logical limit", async () => {
    const ops = Array.from({ length: 11 }, (_, i) => ({ op: "@acme/commerce/_/Customer.create", input: { code: `C${String(i).padStart(3, "0")}`, name: `N${i}` } }));
    const cs = await run(engine.call(`${CS}.propose`, { mode: "atomic", operations: ops }, ctx));
    const p = await run(engine.call(`${CS}.preview`, { id: cs.id }, ctx));
    expect(p.budget.atomicAllowed).toBe(false);
    await run(engine.call(`${CS}.approve`, { id: cs.id, contentHash: p.contentHash }, ctx));
    expect((await fails(engine.call(`${CS}.commit`, { id: cs.id }, ctx))).code).toBe("BudgetExceeded");
  });
});
