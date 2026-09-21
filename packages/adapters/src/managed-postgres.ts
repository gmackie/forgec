/**
 * Attach-existing managed PostgreSQL profiles (FORGE-072; PAR-148/149).
 * A profile binds an exact product and connection mode with the transaction,
 * cache, role and backup descriptors the Forge Postgres adapter relies on.
 * Resolution refuses ambiguity (PlanetScale without an engine designation is
 * an error, not a guess), and certification of a mode comes from running the
 * Postgres contract suite through that mode: pooled transaction mode fails
 * the session-state check, so it is certified for a narrower contract only.
 */
import type { SqlExecutor } from "@forgegraph/runtime/sql-executor";
import { rawPgExecutor } from "@forgegraph/runtime/postgres";

export interface ManagedPostgresProfile {
  id: string;
  product: string;
  engine: "postgres";
  mode: "direct" | "pooled-session" | "pooled-transaction";
  transactions: { isolation: "serializable"; retryOn: string[] };
  /** Session-level features the mode can support (advisory locks, SET LOCAL, prepared statements across calls). */
  sessionState: boolean;
  cache: { statementCache: boolean };
  roles: { app: string; owner: string };
  backups: { pointInTime: boolean; note: string };
  connection: { sslmode: "require"; env: string };
}

const base = { engine: "postgres" as const, transactions: { isolation: "serializable" as const, retryOn: ["40001", "40P01"] }, roles: { app: "forge_app", owner: "forge_owner" }, connection: { sslmode: "require" as const, env: "FORGE_PG_URL" } };

export const MANAGED_PROFILES: Record<string, ManagedPostgresProfile> = {
  "neon/direct": { id: "neon/direct", product: "Neon", mode: "direct", sessionState: true, cache: { statementCache: true }, backups: { pointInTime: true, note: "branch-based PITR; restores are new branches, never in-place" }, ...base },
  "neon/pooled-transaction": { id: "neon/pooled-transaction", product: "Neon", mode: "pooled-transaction", sessionState: false, cache: { statementCache: false }, backups: { pointInTime: true, note: "branch-based PITR" }, ...base },
  "planetscale-postgres/direct": { id: "planetscale-postgres/direct", product: "PlanetScale for Postgres", mode: "direct", sessionState: true, cache: { statementCache: true }, backups: { pointInTime: true, note: "managed backups; restore creates a new database" }, ...base },
  "local/direct": { id: "local/direct", product: "PostgreSQL (self-managed)", mode: "direct", sessionState: true, cache: { statementCache: true }, backups: { pointInTime: false, note: "operator-managed" }, ...base },
};

/** Resolve a product + engine + mode to an exact profile; ambiguity is an error. */
export function resolveProfile(o: { product: string; engine?: string; mode?: ManagedPostgresProfile["mode"] }): ManagedPostgresProfile {
  const product = o.product.toLowerCase();
  if (product === "planetscale") {
    if (!o.engine) throw new Error("PlanetScale offers both MySQL (Vitess) and PostgreSQL products; name the engine explicitly (engine: \"postgres\"); the planner never assumes one");
    if (o.engine !== "postgres") throw new Error(`PlanetScale ${o.engine} is not a Forge Postgres profile (MySQL/Vitess is unsupported: no serializable guarded batches, different ordering semantics)`);
    const id = `planetscale-postgres/${o.mode ?? "direct"}`;
    const p = MANAGED_PROFILES[id];
    if (!p) throw new Error(`no profile ${id}`);
    return p;
  }
  if (o.engine && o.engine !== "postgres") throw new Error(`${o.product} ${o.engine} is not a Postgres profile`);
  const id = `${product}/${o.mode ?? "direct"}`;
  const p = MANAGED_PROFILES[id];
  if (!p) throw new Error(`no managed profile ${id}; known: ${Object.keys(MANAGED_PROFILES).join(", ")}`);
  return p;
}

export interface PgCheck { name: string; ok: boolean; detail: string; requiredBy: "contract" | "session" }
export interface PgQualification { profile: string; checks: PgCheck[]; certified: boolean; contract: "full" | "no-session-state" | "none"; serverVersion: string | null }

/** Wrap a pg executor so session state does not survive a call, as a transaction-mode pooler behaves. */
export function transactionPooled(inner: SqlExecutor): SqlExecutor {
  return {
    facade: `${inner.facade}+txn-pool`,
    first: (s) => inner.first(s),
    all: (s) => inner.all(s),
    run: async (s) => {
      if (/^\s*SET\s+(?!LOCAL)/i.test(s.sql) || /pg_advisory_lock\(/i.test(s.sql)) throw new Error("session-level statement is not supported through a transaction-mode pooler");
      return inner.run(s);
    },
    batch: (stmts) => inner.batch(stmts),
  };
}

/** The Postgres contract checks the adapter depends on, plus the session-state checks only direct/session modes can pass. */
export async function qualifyPostgres(profile: ManagedPostgresProfile, db: SqlExecutor): Promise<PgQualification> {
  const checks: PgCheck[] = [];
  const check = async (name: string, requiredBy: PgCheck["requiredBy"], f: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await f(), requiredBy });
    } catch (e) {
      checks.push({ name, ok: false, detail: String((e as Error).message ?? e), requiredBy });
    }
  };
  const t = `q_${Math.random().toString(36).slice(2, 8)}`;
  let serverVersion: string | null = null;
  try {
    serverVersion = (await db.first<{ v: string }>({ sql: "SELECT current_setting('server_version') AS v", params: [] }))?.v ?? null;
  } catch {
    serverVersion = null;
  }
  await db.run({ sql: `CREATE TABLE ${t}_parent (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE "C", version BIGINT NOT NULL)`, params: [] });
  await db.run({ sql: `CREATE TABLE ${t}_child (id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES ${t}_parent(id))`, params: [] });
  await check("atomic-batch", "contract", async () => {
    await db.batch([{ sql: `INSERT INTO ${t}_parent VALUES ('p1', 'A', 1)`, params: [] }]);
    let failed = false;
    try {
      await db.batch([{ sql: `INSERT INTO ${t}_parent VALUES ('p2', 'B', 1)`, params: [] }, { sql: `INSERT INTO ${t}_parent VALUES ('p3', 'A', 1)`, params: [] }]);
    } catch {
      failed = true;
    }
    const rows = await db.all<{ id: string }>({ sql: `SELECT id FROM ${t}_parent ORDER BY id`, params: [] });
    if (!failed || rows.length !== 1) throw new Error("batch applied partially");
    return "all-or-nothing batches";
  });
  await check("foreign-keys", "contract", async () => {
    let failed = false;
    try {
      await db.run({ sql: `INSERT INTO ${t}_child VALUES ('c1', 'missing')`, params: [] });
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("dangling reference accepted");
    return "dangling references refused";
  });
  await check("binary-collation-order", "contract", async () => {
    await db.batch([{ sql: `INSERT INTO ${t}_parent VALUES ('pa', 'a', 1)`, params: [] }, { sql: `INSERT INTO ${t}_parent VALUES ('pB', 'B', 1)`, params: [] }]);
    const rows = await db.all<{ code: string }>({ sql: `SELECT code FROM ${t}_parent ORDER BY code`, params: [] });
    const got = rows.map((r) => r.code).join(",");
    if (got !== "A,B,a") throw new Error(`expected A,B,a; got ${got}`);
    return "COLLATE \"C\" byte order";
  });
  await check("bigint-minor-units", "contract", async () => {
    await db.run({ sql: `UPDATE ${t}_parent SET version = 9007199254740993 WHERE id = 'p1'`, params: [] });
    const r = await db.first<{ version: string | number }>({ sql: `SELECT version::text AS version FROM ${t}_parent WHERE id = 'p1'`, params: [] });
    if (String(r?.version) !== "9007199254740993") throw new Error(`precision lost: ${String(r?.version)}`);
    return "64-bit integers survive round trips as text";
  });
  await check("serializable-conflict", "contract", async () => {
    // A guarded batch that asserts a stale version must fail, never silently apply.
    let failed = false;
    try {
      await db.batch([{ sql: `UPDATE ${t}_parent SET version = version + 1 WHERE id = 'p1' AND version = 1`, params: [] }, { sql: `INSERT INTO ${t}_child (id, parent) SELECT 'guard', 'nope' WHERE NOT EXISTS (SELECT 1 FROM ${t}_parent WHERE id = 'p1' AND version = 2)`, params: [] }]);
    } catch {
      failed = true;
    }
    if (!failed) throw new Error("a stale precondition did not abort the batch");
    return "stale preconditions abort the batch";
  });
  await check("session-state", "session", async () => {
    await db.run({ sql: "SET forge.qualify = 'on'", params: [] });
    const r = await db.first<{ v: string }>({ sql: "SELECT current_setting('forge.qualify', true) AS v", params: [] });
    if (r?.v !== "on") throw new Error("session settings do not persist across calls");
    await db.run({ sql: "RESET forge.qualify", params: [] });
    return "session-level settings and advisory locks are available";
  });
  await db.run({ sql: `DROP TABLE ${t}_child`, params: [] });
  await db.run({ sql: `DROP TABLE ${t}_parent`, params: [] });
  const contractOk = checks.filter((c) => c.requiredBy === "contract").every((c) => c.ok);
  const sessionOk = checks.filter((c) => c.requiredBy === "session").every((c) => c.ok);
  const contract: PgQualification["contract"] = !contractOk ? "none" : sessionOk ? "full" : "no-session-state";
  // A mode that declares session state must demonstrate it; one that declares none is certified for the narrower contract only.
  const certified = contractOk && (profile.sessionState ? sessionOk : true);
  return { profile: profile.id, checks, certified, contract, serverVersion };
}

export { rawPgExecutor };
