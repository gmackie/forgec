/**
 * Cloudflare D1 storage adapter (plan §10). One `batch()` per logical
 * command; every precondition is evaluated inside the batch through the
 * assertion table's named CHECK, as certified by the M0 spike.
 */
import { Effect } from "effect";
import { err, type ForgeError } from "../errors.js";
import type { Model, Resource, Unique } from "../model.js";
import type { CommitPlan, ListQuery, Receipt, StorageAdapter, StoredRecord } from "../services.js";
import { SqlMapping } from "./sql-mapping.js";

/** Minimal structural type for the D1 binding so this module has no hard dependency on workers-types. */
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<{ results?: unknown[]; meta?: { changes?: number } }[]>;
}
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

const RETRY_ATTEMPTS = 3;

export class D1Storage implements StorageAdapter {
  readonly name = "d1";
  private readonly map: SqlMapping;

  constructor(private readonly db: D1Like, model: Model) {
    this.map = new SqlMapping(model);
  }

  private keyWhere(r: Resource): { sql: string; bind: (tenant: string, id: string) => unknown[] } {
    return r.decorators.tenant ? { sql: "tenant = ? AND id = ?", bind: (t, id) => [t, id] } : { sql: "id = ?", bind: (_t, id) => [id] };
  }

  private wrap<A>(f: () => Promise<A>): Effect.Effect<A, ForgeError> {
    return Effect.tryPromise({ try: f, catch: (e) => err("StorageUnavailable", String((e as Error).message ?? e)) });
  }

  get(tenant: string, r: Resource, id: string): Effect.Effect<StoredRecord | null, ForgeError> {
    const t = this.map.table(r);
    const kw = this.keyWhere(r);
    return this.wrap(async () => {
      const row = await this.db.prepare(`SELECT * FROM ${t.name} WHERE ${kw.sql}`).bind(...kw.bind(tenant, id)).first<Record<string, unknown>>();
      return row ? this.map.fromRow(r, row) : null;
    });
  }

  findUnique(tenant: string, r: Resource, u: Unique, _claimKey: string, values: Record<string, unknown>): Effect.Effect<StoredRecord | null, ForgeError> {
    const t = this.map.table(r);
    const fields = [...u.within, ...u.fields];
    const where = [...(r.decorators.tenant ? ["tenant = ?"] : []), ...fields.map((f) => `${this.map.column(r, f).name} = ?`)].join(" AND ");
    const binds = [...(r.decorators.tenant ? [tenant] : []), ...fields.map((f) => this.map.toColumn(r.fields.find((x) => x.name === f)!, values[f]))];
    return this.wrap(async () => {
      const row = await this.db.prepare(`SELECT * FROM ${t.name} WHERE ${where}`).bind(...binds).first<Record<string, unknown>>();
      return row ? this.map.fromRow(r, row) : null;
    });
  }

  list(tenant: string, r: Resource, q: ListQuery, _sortKeys: (rec: StoredRecord) => string[]): Effect.Effect<{ records: StoredRecord[]; hasMore: boolean }, ForgeError> {
    const t = this.map.table(r);
    const col = (f: string) => this.map.column(r, f).name;
    const field = (f: string) => r.fields.find((x) => x.name === f)!;
    const where: string[] = [];
    const binds: unknown[] = [];
    if (r.decorators.tenant) {
      where.push("tenant = ?");
      binds.push(tenant);
    }
    for (const f of q.list.fields) {
      where.push(`${col(f)} = ?`);
      binds.push(this.map.toColumn(field(f), q.values[f]));
    }
    if (r.decorators.softDelete) where.push("deleted_at IS NULL");
    const order = q.list.order; // always ends with id asc (planner tie-breaker)
    if (q.after) {
      // Keyset predicate for mixed directions: OR of prefix-equal AND next-key-strict clauses.
      const clauses: string[] = [];
      for (let i = 0; i < order.length; i++) {
        const parts: string[] = [];
        for (let j = 0; j < i; j++) {
          parts.push(`${col(order[j]!.field)} = ?`);
          binds.push(this.afterValue(r, order[j]!.field, q.after, j));
        }
        const o = order[i]!;
        parts.push(`${col(o.field)} ${o.direction === "desc" ? "<" : ">"} ?`);
        binds.push(this.afterValue(r, o.field, q.after, i));
        clauses.push(`(${parts.join(" AND ")})`);
      }
      where.push(`(${clauses.join(" OR ")})`);
    }
    const orderBy = order.map((o) => `${col(o.field)} ${o.direction === "desc" ? "DESC" : "ASC"}`).join(", ");
    const sql = `SELECT * FROM ${t.name} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ?`;
    binds.push(q.limit + 1);
    return this.wrap(async () => {
      const { results } = await this.db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
      const rows = results.slice(0, q.limit).map((row) => this.map.fromRow(r, row));
      return { records: rows, hasMore: results.length > q.limit };
    });
  }

  private afterValue(r: Resource, fieldName: string, after: NonNullable<ListQuery["after"]>, i: number): unknown {
    if (fieldName === "id") return after.id;
    return this.map.toColumn(r.fields.find((x) => x.name === fieldName)!, after.values[i]);
  }

  getReceipt(tenant: string, operation: string, key: string): Effect.Effect<Receipt | null, ForgeError> {
    return this.wrap(async () => {
      const row = await this.db.prepare("SELECT * FROM forge_receipt WHERE tenant = ? AND operation = ? AND key = ?").bind(tenant, operation, key).first<Record<string, unknown>>();
      if (!row) return null;
      return { tenant, operation, key, requestHash: String(row["request_hash"]), status: Number(row["status"]), response: JSON.parse(String(row["response"])), createdAt: String(row["created_at"]) };
    });
  }

  commit(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      for (let attempt = 1; ; attempt++) {
        const outcome = yield* self.commitOnce(plan);
        if (outcome === "ok") return;
        if (outcome.code !== "TransientConflict" || attempt >= RETRY_ATTEMPTS) return yield* Effect.fail(outcome);
        yield* Effect.sleep(Math.floor(Math.random() * 25 * attempt));
      }
    });
  }

  private commitOnce(plan: CommitPlan): Effect.Effect<"ok" | ForgeError, never> {
    const { resource: r, tenant, id } = plan;
    const t = this.map.table(r);
    const kw = this.keyWhere(r);
    const stmts: D1Stmt[] = [];

    // 1. assertion: every precondition, evaluated inside the batch
    const preds: string[] = [];
    const predBinds: unknown[] = [];
    if (plan.kind === "create") {
      preds.push(`NOT EXISTS (SELECT 1 FROM ${t.name} WHERE ${kw.sql})`);
      predBinds.push(...kw.bind(tenant, id));
    } else {
      const versionSql = plan.expectedVersion !== null ? " AND version = ?" : "";
      preds.push(`EXISTS (SELECT 1 FROM ${t.name} WHERE ${kw.sql}${versionSql})`);
      predBinds.push(...kw.bind(tenant, id));
      if (plan.expectedVersion !== null) predBinds.push(plan.expectedVersion);
    }
    for (const g of plan.references) {
      const gt = this.map.table(g.resource);
      const gkw = this.keyWhere(g.resource);
      const live = g.resource.decorators.softDelete ? " AND deleted_at IS NULL" : "";
      preds.push(`EXISTS (SELECT 1 FROM ${gt.name} WHERE ${gkw.sql}${live})`);
      predBinds.push(...gkw.bind(tenant, g.id));
    }
    stmts.push(this.db.prepare(`INSERT INTO _forge_assert (op_id, satisfied) SELECT ?, (${preds.join(" AND ")})`).bind(plan.opId, ...predBinds));

    // 2. record write
    const row = this.map.toRow(r, plan.after);
    if (r.decorators.tenant) row["tenant"] = tenant;
    const cols = Object.keys(row);
    if (plan.kind === "create") {
      stmts.push(this.db.prepare(`INSERT INTO ${t.name} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c])));
    } else {
      const sets = cols.filter((c) => c !== "id" && c !== "tenant");
      stmts.push(this.db.prepare(`UPDATE ${t.name} SET ${sets.map((c) => `"${c}" = ?`).join(", ")} WHERE ${kw.sql}`).bind(...sets.map((c) => row[c]), ...kw.bind(tenant, id)));
    }

    // 3. audit, outbox, receipt
    const a = plan.audit;
    stmts.push(this.db.prepare("INSERT INTO forge_audit (tenant, op_id, resource, record_id, kind, new_version, actor, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(a.tenant, a.opId, a.resource, a.recordId, a.kind, a.newVersion, a.actor, a.at, a.payload === undefined ? null : JSON.stringify(a.payload)));
    for (const o of plan.outbox) {
      stmts.push(this.db.prepare("INSERT INTO forge_outbox (tenant, op_id, ordinal, channel, message, payload, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)").bind(o.tenant, o.opId, o.ordinal, o.channel, o.message, JSON.stringify(o.payload), o.createdAt));
    }
    if (plan.receipt) {
      const rc = plan.receipt;
      stmts.push(this.db.prepare("INSERT INTO forge_receipt (tenant, operation, key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(rc.tenant, rc.operation, rc.key, rc.requestHash, rc.status, JSON.stringify(rc.response), rc.createdAt));
    }
    // 4. release the assertion row
    stmts.push(this.db.prepare("DELETE FROM _forge_assert WHERE op_id = ?").bind(plan.opId));

    return Effect.promise(async () => {
      try {
        await this.db.batch(stmts);
        return "ok" as const;
      } catch (e) {
        return await this.classify(e, plan);
      }
    });
  }

  /** Provider error -> stable outcome. The named CHECK identifies a failed precondition; a diagnostic read says which. */
  private async classify(e: unknown, plan: CommitPlan): Promise<ForgeError> {
    const msg = String((e as Error)?.message ?? e);
    if (/CHECK constraint failed: forge_precondition/.test(msg)) {
      const { resource: r, tenant, id } = plan;
      const t = this.map.table(r);
      const kw = this.keyWhere(r);
      const current = await this.db.prepare(`SELECT version FROM ${t.name} WHERE ${kw.sql}`).bind(...kw.bind(tenant, id)).first<{ version?: number }>().catch(() => null);
      if (plan.kind === "create" && current) return err("TransientConflict", "id collision");
      if (plan.kind !== "create") {
        if (!current) return err("NotFound", `${r.name} ${id} not found`);
        if (plan.expectedVersion !== null && current.version !== plan.expectedVersion) return err("VersionConflict", `expected version ${plan.expectedVersion}, current is ${current.version}`);
      }
      for (const g of plan.references) {
        const gt = this.map.table(g.resource);
        const gkw = this.keyWhere(g.resource);
        const live = g.resource.decorators.softDelete ? " AND deleted_at IS NULL" : "";
        const ok = await this.db.prepare(`SELECT 1 AS ok FROM ${gt.name} WHERE ${gkw.sql}${live}`).bind(...gkw.bind(tenant, g.id)).first().catch(() => null);
        if (!ok) return err("ReferenceMissing", `${g.field} does not reference a live record`);
      }
      return err("TransientConflict", "precondition changed concurrently");
    }
    const uq = /UNIQUE constraint failed: (.+?)(?::|$)/.exec(msg);
    if (uq) {
      const cols = uq[1]!.split(",").map((s) => s.trim().split(".").pop()!);
      const table = uq[1]!.trim().split(".")[0]!;
      const name = this.map.uniqueByColumns(table, cols);
      return err("UniqueConflict", "a record with the same unique key exists", name ? { constraint: `${plan.resource.id}.unique.${name}` } : {});
    }
    if (/FOREIGN KEY constraint failed/.test(msg)) return err("ReferenceMissing", "referenced record does not exist");
    if (/SQLITE_BUSY|database is locked|D1_ERROR: Network/i.test(msg)) return err("TransientConflict", msg);
    return err("StorageUnavailable", msg);
  }
}
