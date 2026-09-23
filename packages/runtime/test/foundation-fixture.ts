import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { D1Storage } from "../src/adapters/d1.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { testLayer } from "../src/testing.js";
export function consumerFixture(slug: string, adapter: "memory" | "sqlite") {
  const path = process.env["FORGE_FOUNDATION_CONSUMER"] ?? resolve(import.meta.dirname, `../../../conformance/fixtures/${slug}-consumer`);
  const model = new Model(JSON.parse(readFileSync(resolve(path, "app.json"), "utf8")) as AppBundle);
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(path, "d1/0001_init.sql"), "utf8"));
  const run = (s: SqlStatement) => ({ changes: Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes) });
  const executor: SqlExecutor = {
    facade: "sqlite-test",
    first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T | null,
    all: async <T>(s: SqlStatement) => db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[],
    run: async s => run(s),
    batch: async statements => { db.exec("BEGIN"); try { const result = statements.map(run); db.exec("COMMIT"); return result; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
  return { engine: new Engine(model, testLayer(adapter === "memory" ? new MemoryStorage() : new D1Storage(executor, model))), close: () => db.close() };
}
