/**
 * CSV import (plan §13): the same mutation engine. A CSV is a changeset
 * proposal with a mapping profile; whole-file uniqueness and cross-row checks
 * are reported per row before anything commits.
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
const IMPORT = "@acme/commerce/_/imports";
const CS = "@acme/commerce/_/changesets";

let engine: Engine;
beforeEach(() => {
  engine = new Engine(model, testLayer(new MemoryStorage()));
});

const csv = (text: string) => btoa(text);

describe("CSV import", () => {
  it("inspects a file: header, sample rows, suggested mapping by header name", async () => {
    const ins = await run(engine.call(`${IMPORT}.inspect`, { resource: "@acme/commerce/_/Customer", csv: csv("Code,Name,Email,tier\nacme,Acme,a@b.co,gold\n") }, ctx));
    expect(ins.header).toEqual(["Code", "Name", "Email", "tier"]);
    expect(ins.rows).toBe(1);
    expect(ins.suggestedMapping).toEqual({ Code: "code", Name: "name", Email: "email", tier: "tier" });
    expect(ins.errors).toEqual([]);
  });

  it("stages a changeset: normalized per-row creates, per-row validation errors, whole-file duplicate detection", async () => {
    const text = "code,name,email,tier\n acme ,Acme,,gold\nbeta,Beta,ops@beta.co,\nab,Bad,,platinum\nACME,Dup,,standard\n";
    const staged = await run(engine.call(`${IMPORT}.stage`, { resource: "@acme/commerce/_/Customer", csv: csv(text), mapping: { code: "code", name: "name", email: "email", tier: "tier" }, mode: "resumable" }, ctx));
    expect(staged.changeset).toBeTruthy();
    expect(staged.rows).toBe(4);
    expect(staged.rowErrors).toEqual([{ line: 5, code: "DuplicateInFile", path: "code", message: expect.stringContaining("line 2") }]);
    const preview = await run(engine.call(`${CS}.preview`, { id: staged.changeset }, ctx));
    expect(preview.items.map((i: any) => i.status)).toEqual(["ok", "ok", "error"]); // the duplicate row was excluded at staging
    expect(preview.items[0].result).toMatchObject({ code: "ACME", name: "Acme", email: null, tier: "gold" });
    expect(preview.items[1].result).toMatchObject({ code: "BETA", tier: "standard" }); // empty cell -> default
    expect(preview.items[2].error.code).toBe("ValidationFailed");
    await run(engine.call(`${CS}.approve`, { id: staged.changeset, contentHash: preview.contentHash }, ctx));
    const committed = await run(engine.call(`${CS}.commit`, { id: staged.changeset }, ctx));
    expect(committed.status).toBe("partially-committed");
    expect(committed.results.map((r: any) => r.status)).toEqual(["committed", "committed", "error"]);
  });

  it("upsert by a unique key: existing records become updates with their current version", async () => {
    const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "Old", tier: "gold" }, ctx));
    const staged = await run(engine.call(`${IMPORT}.stage`, { resource: "@acme/commerce/_/Customer", csv: csv("code,name\nacme,New Name\nnovel,Brand New\n"), mapping: { code: "code", name: "name" }, upsertBy: "code" }, ctx));
    const preview = await run(engine.call(`${CS}.preview`, { id: staged.changeset }, ctx));
    expect(preview.items[0].op).toBe("@acme/commerce/_/Customer.update");
    expect(preview.items[0].diff).toEqual([{ path: "name", before: "Old", after: "New Name" }]);
    expect(preview.items[1].op).toBe("@acme/commerce/_/Customer.create");
    await run(engine.call(`${CS}.approve`, { id: staged.changeset, contentHash: preview.contentHash }, ctx));
    const done = await run(engine.call(`${CS}.commit`, { id: staged.changeset }, ctx));
    expect(done.status).toBe("committed");
    expect(await run(engine.call("@acme/commerce/_/Customer.get", { id: c.id }, ctx))).toMatchObject({ name: "New Name", tier: "gold", version: 2 });
  });

  it("rejects unknown mapping targets and malformed files with a structured error", async () => {
    const e = await fails(engine.call(`${IMPORT}.stage`, { resource: "@acme/commerce/_/Customer", csv: csv("x\n1\n"), mapping: { x: "nope" } }, ctx));
    expect(e.code).toBe("ValidationFailed");
    const bad = await run(engine.call(`${IMPORT}.inspect`, { resource: "@acme/commerce/_/Customer", csv: csv('a,b\n"open\n') }, ctx));
    expect(bad.errors[0].code).toBe("UnterminatedQuote");
  });
});
