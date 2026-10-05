/** Shared feature conformance stores. PostgreSQL uses a unique schema per test,
 * never resets public, and exercises generated PostgreSQL DDL through both facades. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { D1Storage } from "../../src/adapters/d1.js";
import { MemoryStorage } from "../../src/adapters/memory.js";
import { PostgresStorage, rawPgExecutor, drizzlePgExecutor } from "../../src/adapters/postgres.js";
import type { SqlExecutor, SqlStatement } from "../../src/adapters/sql-executor.js";
import type { Model } from "../../src/model.js";

export const featureAdapters = ["memory", "sqlite", "postgres/raw", "postgres/drizzle"] as const;
export const unavailable = (adapter: typeof featureAdapters[number]) => adapter.startsWith("postgres/") && !process.env["FORGE_PG_URL"];
const ddl = (fixture: string, dialect: string) => readFileSync(resolve(import.meta.dirname, "../../../../conformance/fixtures", fixture, dialect, "0001_init.sql"), "utf8");
export async function featureStorage(fixture: string, model: Model, adapter: typeof featureAdapters[number]) {
  if (adapter === "memory") return { storage: new MemoryStorage(), close: async () => {} };
  if (adapter === "sqlite") {
    const db = new DatabaseSync(":memory:");
    try { db.exec(ddl(fixture, "d1")); } catch (error) { db.close(); throw error; }
    const run = (s: SqlStatement) => ({ changes: Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes) });
    const executor: SqlExecutor = {
      facade: "sqlite-test",
      first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T | null,
      all: async <T>(s: SqlStatement) => db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[],
      run: async s => run(s),
      batch: async statements => {
        db.exec("BEGIN");
        try { const result = statements.map(run); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    };
    return { storage: new D1Storage(executor, model), close: async () => { db.close(); } };
  }
  const schema = `forge_feature_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: process.env["FORGE_PG_URL"], max: 1 });
  const pool = new pg.Pool({ connectionString: process.env["FORGE_PG_URL"], max: 8, options: `-c search_path=${schema}` });
  const close = async () => {
    try { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(ddl(fixture, "postgres"));
    const executor = adapter === "postgres/raw" ? rawPgExecutor(pool) : await drizzlePgExecutor(pool);
    return { storage: new PostgresStorage(executor, model), close };
  } catch (error) { await close(); throw error; }
}
