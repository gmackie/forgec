import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  SqlExecutor,
  SqlStatement,
} from "@forgegraph/runtime/sql-executor";
import { Studio } from "./studio.js";
export function sqliteStudio(
  db: DatabaseSync,
  migration: string,
  secret: string,
) {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(
    "CREATE TABLE IF NOT EXISTS console_studio_migrations (version INTEGER PRIMARY KEY)",
  );
  if (
    !db
      .prepare("SELECT version FROM console_studio_migrations WHERE version=1")
      .get()
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration);
      db.exec("INSERT INTO console_studio_migrations VALUES (1); COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  const execute = (s: SqlStatement) =>
    db.prepare(s.sql).run(...(s.params as SQLInputValue[]));
  const executor: SqlExecutor = {
    facade: "node-sqlite",
    first: async <T>(s: SqlStatement) =>
      (db.prepare(s.sql).get(...(s.params as SQLInputValue[])) as
        T | undefined) ?? null,
    all: async <T>(s: SqlStatement) =>
      db.prepare(s.sql).all(...(s.params as SQLInputValue[])) as T[],
    run: async (s) => ({ changes: Number(execute(s).changes) }),
    batch: async (statements) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((s) => ({
          changes: Number(execute(s).changes),
        }));
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return new Studio(executor, secret);
}
