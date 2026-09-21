/**
 * SQLite-dialect profiles beyond D1 (FORGE-073; PAR-150). The D1 storage
 * adapter compiles logical plans to SQLite SQL and needs one atomic
 * primitive: a transactional batch. Any engine that speaks the dialect can
 * be *offered* an executor here, but it is certified only by passing the
 * qualification suite below (guarded batches, foreign keys, binary ordering,
 * `INSERT OR IGNORE`, `RETURNING`, assertion semantics) and then the full
 * conformance scenarios. Syntax compatibility alone proves nothing: an engine
 * that ignores foreign keys or applies a batch partially is rejected.
 *
 * `nodeSqliteExecutor` wraps Node's built-in `node:sqlite` (pinned SQLite
 * library version reported by the engine). Turso/libSQL gets the same
 * interface through `@libsql/client`; its profile stays `unverified` until the
 * suite has run against a real endpoint (FORGE_TURSO_URL).
 */
import type { SqlExecutor, SqlStatement } from "@forge/runtime/sql-executor";

export interface SqliteProfile {
  id: string;
  engine: string;
  client: string;
  dialect: "sqlite";
  /** Guarantees the executor must demonstrate; the suite checks each one. */
  requires: readonly string[];
}

export const PROFILES: Record<string, SqliteProfile> = {
  "cloudflare-d1": { id: "cloudflare-d1", engine: "cloudflare-d1", client: "workers binding", dialect: "sqlite", requires: ["atomic-batch", "foreign-keys", "binary-order", "insert-or-ignore", "returning", "assertion-abort"] },
  "sqlite-node": { id: "sqlite-node", engine: "sqlite (node:sqlite)", client: "node:sqlite (Node >= 22.5)", dialect: "sqlite", requires: ["atomic-batch", "foreign-keys", "binary-order", "insert-or-ignore", "returning", "assertion-abort"] },
  turso: { id: "turso", engine: "libsql", client: "@libsql/client (pin exact version at certification)", dialect: "sqlite", requires: ["atomic-batch", "foreign-keys", "binary-order", "insert-or-ignore", "returning", "assertion-abort"] },
};

interface NodeSqliteLike {
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } };
  exec(sql: string): void;
}

/** SqlExecutor over `node:sqlite`'s DatabaseSync. Batches run in one transaction; any failure rolls back all of it. */
export function nodeSqliteExecutor(db: NodeSqliteLike, o: { facade?: string; foreignKeys?: boolean } = {}): SqlExecutor {
  db.exec(o.foreignKeys === false ? "PRAGMA foreign_keys = OFF" : "PRAGMA foreign_keys = ON");
  const norm = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);
  const row = (r: unknown) => (r && typeof r === "object" ? Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, norm(v)])) : r);
  return {
    facade: o.facade ?? "node-sqlite",
    first: async (s: SqlStatement) => (row(db.prepare(s.sql).get(...(s.params as never[]))) as never) ?? null,
    all: async (s: SqlStatement) => db.prepare(s.sql).all(...(s.params as never[])).map(row) as never,
    run: async (s: SqlStatement) => ({ changes: Number(db.prepare(s.sql).run(...(s.params as never[])).changes) }),
    batch: async (statements: SqlStatement[]) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = statements.map((s) => ({ changes: Number(db.prepare(s.sql).run(...(s.params as never[])).changes) }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export interface QualificationCheck { name: string; ok: boolean; detail: string }
export interface Qualification { profile: string; facade: string; engineVersion: string | null; checks: QualificationCheck[]; certified: boolean; missing: string[] }

/** D1-equivalent invariants. Runs on any executor; the verdict is per guarantee, never by engine name. */
export async function qualifySqlite(profile: SqliteProfile, db: SqlExecutor): Promise<Qualification> {
  const checks: QualificationCheck[] = [];
  const check = async (name: string, f: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await f() });
    } catch (e) {
      checks.push({ name, ok: false, detail: String((e as Error).message ?? e) });
    }
  };
  const t = `q_${Math.random().toString(36).slice(2, 8)}`;
  let engineVersion: string | null = null;
  try {
    engineVersion = String((await db.first<{ v: string }>({ sql: "SELECT sqlite_version() AS v", params: [] }))?.v ?? null);
  } catch {
    engineVersion = null;
  }
  await db.run({ sql: `CREATE TABLE ${t}_parent (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, version INTEGER NOT NULL)`, params: [] });
  await db.run({ sql: `CREATE TABLE ${t}_child (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES ${t}_parent(id))`, params: [] });

  await check("atomic-batch", async () => {
    await db.batch([{ sql: `INSERT INTO ${t}_parent VALUES ('p1', 'A', 1)`, params: [] }]);
    let failed = false;
    try {
      await db.batch([{ sql: `INSERT INTO ${t}_parent VALUES ('p2', 'B', 1)`, params: [] }, { sql: `INSERT INTO ${t}_parent VALUES ('p3', 'A', 1)`, params: [] }]);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("a batch with a unique violation did not fail");
    const rows = await db.all<{ id: string }>({ sql: `SELECT id FROM ${t}_parent ORDER BY id`, params: [] });
    if (rows.map((r) => r.id).join(",") !== "p1") throw new Error(`batch applied partially: ${rows.map((r) => r.id).join(",")}`);
    return "a failing statement rolls back every statement of the batch";
  });
  await check("foreign-keys", async () => {
    let failed = false;
    try {
      await db.run({ sql: `INSERT INTO ${t}_child VALUES ('c1', 'missing')`, params: [] });
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("a dangling reference was accepted: foreign keys are not enforced");
    return "dangling references are refused";
  });
  await check("assertion-abort", async () => {
    // The guarded-batch pattern: an assertion statement that touches zero rows must abort the batch.
    let failed = false;
    try {
      await db.batch([
        { sql: `UPDATE ${t}_parent SET version = version + 1 WHERE id = 'p1' AND version = 99`, params: [] },
        { sql: `INSERT INTO ${t}_child SELECT 'c2', 'p1' WHERE (SELECT changes()) = 1`, params: [] },
        { sql: `INSERT INTO ${t}_child SELECT 'assert', 'nope' WHERE (SELECT changes()) = 0`, params: [] },
      ]);
    } catch {
      failed = true;
    }
    const children = await db.all({ sql: `SELECT id FROM ${t}_child`, params: [] });
    if (!failed || children.length !== 0) throw new Error("a stale precondition did not abort the guarded batch");
    return "a stale precondition aborts the batch through changes()";
  });
  await check("insert-or-ignore", async () => {
    const r = await db.run({ sql: `INSERT OR IGNORE INTO ${t}_parent VALUES ('p1', 'A', 1)`, params: [] });
    if (r.changes !== 0) throw new Error("INSERT OR IGNORE reported a change for a duplicate");
    return "duplicate keys are ignored and reported as zero changes";
  });
  await check("binary-order", async () => {
    await db.batch([{ sql: `INSERT INTO ${t}_parent VALUES ('pa', 'a', 1)`, params: [] }, { sql: `INSERT INTO ${t}_parent VALUES ('pB', 'B', 1)`, params: [] }]);
    const rows = await db.all<{ code: string }>({ sql: `SELECT code FROM ${t}_parent ORDER BY code COLLATE BINARY`, params: [] });
    const got = rows.map((r) => r.code).join(",");
    if (got !== "A,B,a") throw new Error(`expected byte order A,B,a; got ${got}`);
    return "ORDER BY is bytewise (matches the canonical cursor order)";
  });
  await check("returning", async () => {
    const r = await db.first<{ version: number }>({ sql: `UPDATE ${t}_parent SET version = version + 1 WHERE id = 'p1' RETURNING version`, params: [] });
    if (r?.version !== 2) throw new Error("RETURNING is not supported");
    return "RETURNING yields the written row";
  });
  await db.run({ sql: `DROP TABLE ${t}_child`, params: [] });
  await db.run({ sql: `DROP TABLE ${t}_parent`, params: [] });
  const missing = profile.requires.filter((g) => !checks.find((c) => c.name === g)?.ok);
  return { profile: profile.id, facade: db.facade, engineVersion, checks, certified: missing.length === 0, missing };
}
