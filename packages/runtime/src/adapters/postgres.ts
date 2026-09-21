/**
 * PostgreSQL adapter (FORGE-033/034). The relational plan and the guarded
 * mutation protocol are the SQL ones already executed on D1: every commit is a
 * list of statements whose first inserts the `_forge_assert` row with the
 * evaluated preconditions and whose CHECK aborts the batch. Here a batch is
 * one transaction; PostgreSQL error classes are mapped onto the same stable
 * outcomes (unique conflict, missing reference, precondition failed,
 * serialization retry). Text columns carry `COLLATE "C"` so keyset order is
 * the same byte order D1 and DynamoDB produce.
 *
 * Facades (plan §5.2): `raw-pg` (node-postgres) and `drizzle-pg`
 * (drizzle-orm/node-postgres). Both bind parameters positionally, never
 * interpolate, and run the atomic batch through one `BEGIN … COMMIT` on a
 * single pooled connection whose transaction-local settings are reset on
 * every exit path, so a pooled connection never retains a prior tenant.
 */
import { types, type Pool, type PoolClient } from "pg";
import type { Model } from "../model.js";
import { D1Storage } from "./d1.js";
import type { SqlExecutor, SqlStatement } from "./sql-executor.js";

// BIGINT (int8) arrives as text by default; the portable integer range is the JS safe range.
types.setTypeParser(20, (v) => Number(v));

/** `?` placeholders (shared SQL plan) → `$n`; the one SQLite-only clause in the plan gets its standard form. */
export function toPositional(sql: string): string {
  let n = 0;
  const std = sql.startsWith("INSERT OR IGNORE INTO ") ? sql.replace("INSERT OR IGNORE INTO ", "INSERT INTO ") + " ON CONFLICT DO NOTHING" : sql;
  return std.replace(/\?/g, () => `$${++n}`);
}

/** Map a PostgreSQL error to the message vocabulary the shared classifier understands. */
export function translateError(e: unknown, statementSql: string): Error {
  const pe = e as { code?: string; message?: string; constraint?: string; detail?: string; table?: string };
  const code = pe.code ?? "";
  if (code === "23514" && (pe.constraint === "forge_precondition" || /forge_precondition/.test(pe.message ?? ""))) return new Error("CHECK constraint failed: forge_precondition");
  if (code === "23505") {
    // detail: Key (tenant, code)=(t, ACME) already exists.
    const cols = /Key \(([^)]+)\)=/.exec(pe.detail ?? "")?.[1]?.split(",").map((s) => s.trim()) ?? [];
    const table = pe.table ?? /INSERT INTO (\w+)/.exec(statementSql)?.[1] ?? "";
    return new Error(`UNIQUE constraint failed: ${cols.map((c) => `${table}.${c}`).join(", ")}`);
  }
  if (code === "23503") return new Error("FOREIGN KEY constraint failed");
  if (code === "40001" || code === "40P01" || code === "55P03") return new Error(`database is locked: ${pe.message}`);
  return e instanceof Error ? e : new Error(String(pe.message ?? e));
}

async function runTransaction(client: PoolClient, statements: SqlStatement[], tenant?: string): Promise<{ changes: number }[]> {
  const out: { changes: number }[] = [];
  // D1 executes a batch serially against a single writer; SERIALIZABLE gives the same guarantee for
  // the guarded protocol (the assertion row reads what the transaction commits against). A
  // serialization failure surfaces as TransientConflict and the caller re-plans from fresh state.
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    // Transaction-local context for RLS-style policies; SET LOCAL dies with the transaction on every path.
    if (tenant) await client.query("SELECT set_config('forge.tenant', $1, true)", [tenant]);
    for (const s of statements) {
      try {
        const r = await client.query(toPositional(s.sql), s.params as unknown[]);
        out.push({ changes: r.rowCount ?? 0 });
      } catch (e) {
        throw translateError(e, s.sql);
      }
    }
    try {
      await client.query("COMMIT"); // a serialization failure can surface here, not only on a statement
    } catch (e) {
      throw translateError(e, "COMMIT");
    }
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

/** node-postgres facade. */
export function rawPgExecutor(pool: Pool): SqlExecutor {
  const q = async <T = Record<string, unknown>>(s: SqlStatement): Promise<T[]> => {
    try {
      return (await pool.query(toPositional(s.sql), s.params as unknown[])).rows as T[];
    } catch (e) {
      throw translateError(e, s.sql);
    }
  };
  return {
    facade: "raw-pg",
    first: async (s) => ((await q(s))[0] as never) ?? null,
    all: (s) => q(s) as Promise<never[]>,
    run: async (s) => {
      try {
        return { changes: (await pool.query(toPositional(s.sql), s.params as unknown[])).rowCount ?? 0 };
      } catch (e) {
        throw translateError(e, s.sql);
      }
    },
    batch: async (statements) => {
      const client = await pool.connect();
      try {
        return await runTransaction(client, statements);
      } finally {
        // Nothing transaction-local survives; RESET ALL clears session settings a facade may have set.
        await client.query("RESET ALL").catch(() => undefined);
        client.release();
      }
    },
  };
}

/**
 * drizzle-orm/node-postgres facade: reads and single statements through drizzle's
 * `sql` template (positional binds), the atomic batch through one pg transaction —
 * drizzle exposes no batch primitive on Postgres, and a JS-level transaction
 * callback would be the wrong layer for the guarded protocol.
 */
export async function drizzlePgExecutor(pool: Pool): Promise<SqlExecutor> {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { sql } = await import("drizzle-orm");
  const d = drizzle(pool);
  const raw = rawPgExecutor(pool);
  const toDrizzle = (s: SqlStatement) => {
    const chunks = s.sql.split("?");
    let built = sql.raw(chunks[0] ?? "");
    for (let i = 1; i < chunks.length; i++) built = sql`${built}${s.params[i - 1]}${sql.raw(chunks[i] ?? "")}`;
    return built;
  };
  const exec = async (s: SqlStatement) => {
    try {
      return await d.execute(toDrizzle(s));
    } catch (e) {
      throw translateError(e, s.sql);
    }
  };
  return {
    facade: "drizzle-pg",
    first: async (s) => ((await exec(s)).rows[0] as never) ?? null,
    all: async (s) => (await exec(s)).rows as never[],
    run: async (s) => ({ changes: (await exec(s)).rowCount ?? 0 }),
    batch: (statements) => raw.batch(statements),
  };
}

/** The same storage semantics as D1, on PostgreSQL. */
export class PostgresStorage extends D1Storage {
  constructor(executor: SqlExecutor, model: Model) {
    super(executor, model);
    (this as { name: string }).name = `postgres/${executor.facade}`;
  }

  /**
   * A serialization failure under SERIALIZABLE is the expected outcome of concurrency, not a
   * fault: PostgreSQL's own guidance is to retry the whole transaction. Every commit in this
   * protocol writes `_forge_assert` and may write `forge_outbox`, so writers that share no
   * business state still overlap on predicate locks and conflict. Inheriting D1's budget (3
   * attempts inside 75ms) meant independent concurrent writes failed with a 503 at a
   * double-digit rate — the same calls that succeed on D1 and DynamoDB, which is precisely the
   * kind of divergence the differential suite exists to catch.
   *
   * Exponential with jitter, ~2s of total budget before giving up. A caller that still sees
   * TransientConflict is seeing real, sustained contention rather than an artefact of the
   * isolation level.
   */
  protected override readonly retryAttempts = 10;
  protected override retryDelayMs(attempt: number): number {
    return Math.floor(2 ** attempt * 2 + Math.random() * 10 * attempt);
  }
}

export function createPostgresStorage(pool: Pool, model: Model): PostgresStorage {
  return new PostgresStorage(rawPgExecutor(pool), model);
}
