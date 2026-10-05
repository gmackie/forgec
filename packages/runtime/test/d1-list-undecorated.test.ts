// #197: a resource with neither @tenant nor @softDelete has no list predicates, and
// `WHERE ORDER BY` is a SQLite syntax error (seen as HTTP 503 on projection rebuild).
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { Model, type AppBundle } from "../src/model.js";

const fixtures = resolve(import.meta.dirname, "../../../conformance/fixtures");

it("lists an undecorated resource without an empty WHERE clause", async () => {
  const bundle = JSON.parse(readFileSync(resolve(fixtures, "acme.app.json"), "utf8")) as AppBundle;
  const model = new Model(bundle);
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(fixtures, "acme.0001_init.sql"), "utf8"));
  const statements: string[] = [];
  const executor: SqlExecutor = {
    facade: "sqlite-test",
    first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...(s.params as SQLInputValue[])) ?? null) as T | null,
    all: async <T>(s: SqlStatement) => {
      statements.push(s.sql);
      return db.prepare(s.sql).all(...(s.params as SQLInputValue[])) as T[];
    },
    run: async (s) => ({ changes: Number(db.prepare(s.sql).run(...(s.params as SQLInputValue[])).changes) }),
    batch: async () => { throw new Error("unused"); },
  };
  const storage = new D1Storage(executor, model);
  const declared = model.resources.find((r) => r.decorators.tenant || r.decorators.softDelete)!;
  const resource = { ...declared, decorators: { ...declared.decorators, tenant: false, softDelete: false } };
  const list = { name: "all", fields: [], order: [{ field: "id", direction: "asc" as const }] };
  const page = await Effect.runPromise(
    storage.list("acme", resource, { list, values: {}, after: null, limit: 10 }, () => []),
  );
  expect(page).toEqual({ records: [], hasMore: false });
  expect(statements.at(-1)).not.toMatch(/WHERE\s+ORDER/);
});
