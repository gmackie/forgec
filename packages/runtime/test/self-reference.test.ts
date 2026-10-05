// #200: a resource with a required self-reference (`root : Thread @immutable`) must be creatable
// through the public API (`$self`) and restorable by identity-preserving import.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { D1Storage } from "../src/adapters/d1.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import type { Snapshot } from "../src/portability.js";
import { testLayer } from "../src/testing.js";

const fixture = resolve(import.meta.dirname, "../../../conformance/fixtures/self-reference");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const op = "@fixture/self-reference/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "self-reference" };

function storage(adapter: string) {
  if (adapter === "memory") return new MemoryStorage();
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(fixture, "d1/0001_init.sql"), "utf8"));
  const execute = (s: SqlStatement) => ({ changes: Number(db.prepare(s.sql).run(...(s.params as SQLInputValue[])).changes) });
  const executor: SqlExecutor = {
    facade: "sqlite-test",
    first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...(s.params as SQLInputValue[])) ?? null) as T | null,
    all: async <T>(s: SqlStatement) => db.prepare(s.sql).all(...(s.params as SQLInputValue[])) as T[],
    run: async (s) => execute(s),
    batch: async (statements) => {
      db.exec("BEGIN");
      try { const results = statements.map(execute); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  return new D1Storage(executor, new Model(bundle));
}

function engine(adapter: string) {
  const e = new Engine(new Model(bundle), testLayer(storage(adapter)));
  return (name: string, input: Record<string, unknown>) => Effect.runPromise(e.call(op + name, input, ctx)) as Promise<any>;
}

for (const adapter of ["memory", "sqlite"]) {
  it(`${adapter}: creates a self-referencing root with $self and replies that reference it`, async () => {
    const call = engine(adapter);
    const root = await call("Thread.create", { title: "Atlas", root: "$self" });
    expect(root.root).toBe(root.id);
    const reply = await call("Thread.create", { title: "Reply", root: root.id });
    expect(reply.root).toBe(root.id);
    await expect(call("Thread.create", { title: "Dangling", root: "missing-thread" })).rejects.toMatchObject({ code: "ReferenceMissing" });
    // `$self` only names the record being written, never another resource.
    await expect(call("Note.create", { thread: "$self" })).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it(`${adapter}: imports root threads and replies regardless of snapshot order`, async () => {
    const source = engine(adapter);
    const root = await source("Thread.create", { title: "Atlas", root: "$self" });
    const replies = [await source("Thread.create", { title: "One", root: root.id }), await source("Thread.create", { title: "Two", root: root.id })];
    const snapshot = (await source("admin.export", {})) as Snapshot;
    const threads = snapshot.resources[Object.keys(snapshot.resources).find((k) => k.endsWith("Thread"))!]!;
    threads.records.reverse(); // replies before their root
    const target = engine(adapter);
    const imported = await target("admin.import", { snapshot });
    expect(Object.values(imported.imported).reduce((a: number, b) => a + (b as number), 0)).toBe(3);
    expect((await target("Thread.get", { id: root.id })).root).toBe(root.id);
    expect((await target("Thread.get", { id: replies[1]!.id })).root).toBe(root.id);
  });
}
