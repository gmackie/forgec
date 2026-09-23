/**
 * Cloudflare D1 storage adapter (plan §10). One `batch()` per logical
 * command; every precondition is evaluated inside the batch through the
 * assertion table's named CHECK, as certified by the M0 spike.
 */
import { Effect } from "effect";
import { absenceWriteConflict } from "../atomic-guards.js";
import { err, type ForgeError } from "../errors.js";
import type { Model, Resource, Unique } from "../model.js";
import type { AtomicAbsenceGuard, DocumentWrite, CommitPlan, IntervalGuard, ListQuery, OutboxRow, Receipt, StorageAdapter, StoredRecord } from "../services.js";
import { SqlMapping } from "./sql-mapping.js";
import { rawD1Executor, type SqlExecutor, type SqlStatement } from "./sql-executor.js";

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

const st = (sql: string, ...params: unknown[]): SqlStatement => ({ sql, params });

/** D1 serializes writes behind one writer, so a transient conflict is rare and clears quickly. */
const RETRY_ATTEMPTS = 3;
/** D1: 100 bound parameters per statement; a batch may hold many statements. Budget counts statements conservatively. */
const D1_BATCH_STATEMENT_LIMIT = 100;

export class D1Storage implements StorageAdapter {
  readonly name: string;
  readonly atomicAbsenceGuards = true;
  private readonly map: SqlMapping;
  private readonly db: SqlExecutor;

  /** Accepts a raw D1 binding or any SqlExecutor facade over one. */
  constructor(db: D1Like | SqlExecutor, model: Model) {
    this.db = "facade" in db ? db : rawD1Executor(db);
    this.name = `d1/${this.db.facade}`;
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
      const row = await this.db.first(st(`SELECT * FROM ${t.name} WHERE ${kw.sql}`, ...kw.bind(tenant, id)));
      return row ? this.map.fromRow(r, row) : null;
    });
  }

  findUnique(tenant: string, r: Resource, u: Unique, _claimKey: string, values: Record<string, unknown>): Effect.Effect<StoredRecord | null, ForgeError> {
    const t = this.map.table(r);
    const fields = [...u.within, ...u.fields];
    const where = [...(r.decorators.tenant ? ["tenant = ?"] : []), ...fields.map((f) => `${this.map.column(r, f).name} = ?`)].join(" AND ");
    const binds = [...(r.decorators.tenant ? [tenant] : []), ...fields.map((f) => this.map.toColumn(r.fields.find((x) => x.name === f)!, values[f]))];
    return this.wrap(async () => {
      const row = await this.db.first(st(`SELECT * FROM ${t.name} WHERE ${where}`, ...binds));
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
      const results = await this.db.all(st(sql, ...binds));
      const rows = results.slice(0, q.limit).map((row) => this.map.fromRow(r, row));
      return { records: rows, hasMore: results.length > q.limit };
    });
  }

  private afterValue(r: Resource, fieldName: string, after: NonNullable<ListQuery["after"]>, i: number): unknown {
    if (fieldName === "id") return after.id;
    return this.map.toColumn(r.fields.find((x) => x.name === fieldName)!, after.values[i]);
  }

  countDependents(tenant: string, child: Resource, field: string, id: string): Effect.Effect<number, ForgeError> {
    const t = this.map.table(child);
    const col = this.map.column(child, field).name;
    const live = child.decorators.softDelete ? " AND deleted_at IS NULL" : "";
    const tenantSql = child.decorators.tenant ? "tenant = ? AND " : "";
    const binds = child.decorators.tenant ? [tenant, id] : [id];
    return this.wrap(async () => {
      const row = await this.db.first<{ n: number }>(st(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${tenantSql}${col} = ?${live}`, ...binds));
      return Number(row?.n ?? 0);
    });
  }

  // ---------------------------------------------------------- effective dating and hierarchy (§18)
  /** SQL for "a live row of the group overlaps [from, until)". Half-open: a.from < b.until AND b.from < a.until. */
  private overlapSql(r: Resource, g: IntervalGuard): { sql: string; binds: unknown[] } {
    const t = this.map.table(r);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (r.decorators.tenant) where.push("tenant = ?");
    for (const [i, f] of g.groupFields.entries()) {
      where.push(`${this.map.column(r, f).name} = ?`);
      binds.push(this.map.toColumn(r.fields.find((x) => x.name === f)!, g.groupValues[i]));
    }
    where.push("id <> ?");
    binds.push(g.excludeId);
    if (r.decorators.softDelete) where.push("deleted_at IS NULL");
    where.push("(effective_until IS NULL OR ? < effective_until)");
    binds.push(g.from);
    if (g.until !== null) {
      where.push("effective_from < ?");
      binds.push(g.until);
    }
    return { sql: `SELECT * FROM ${t.name} WHERE ${where.join(" AND ")}`, binds };
  }
  overlapping(tenant: string, r: Resource, g: IntervalGuard): Effect.Effect<StoredRecord[], ForgeError> {
    const { sql, binds } = this.overlapSql(r, g);
    const all = r.decorators.tenant ? [tenant, ...binds] : binds;
    return this.wrap(async () => (await this.db.all(st(`${sql} LIMIT 10`, ...all))).map((row) => this.map.fromRow(r, row)));
  }
  effectiveAt(tenant: string, r: Resource, groupFields: string[], groupValues: unknown[], at: string): Effect.Effect<StoredRecord | null, ForgeError> {
    const t = this.map.table(r);
    const where: string[] = [];
    const binds: unknown[] = [];
    if (r.decorators.tenant) {
      where.push("tenant = ?");
      binds.push(tenant);
    }
    for (const [i, f] of groupFields.entries()) {
      where.push(`${this.map.column(r, f).name} = ?`);
      binds.push(this.map.toColumn(r.fields.find((x) => x.name === f)!, groupValues[i]));
    }
    if (r.decorators.softDelete) where.push("deleted_at IS NULL");
    where.push("effective_from <= ?", "(effective_until IS NULL OR ? < effective_until)");
    binds.push(at, at);
    return this.wrap(async () => {
      const row = await this.db.first(st(`SELECT * FROM ${t.name} WHERE ${where.join(" AND ")} LIMIT 1`, ...binds));
      return row ? this.map.fromRow(r, row) : null;
    });
  }
  children(tenant: string, r: Resource, parentField: string, id: string, limit: number): Effect.Effect<StoredRecord[], ForgeError> {
    const t = this.map.table(r);
    const col = this.map.column(r, parentField).name;
    const order = r.fields.some((f) => f.name === "name") ? "name, id" : "id";
    const live = r.decorators.softDelete ? " AND deleted_at IS NULL" : "";
    const tenantSql = r.decorators.tenant ? "tenant = ? AND " : "";
    const binds = r.decorators.tenant ? [tenant, id, limit] : [id, limit];
    return this.wrap(async () => (await this.db.all(st(`SELECT * FROM ${t.name} WHERE ${tenantSql}${col} = ?${live} ORDER BY ${order} LIMIT ?`, ...binds))).map((row) => this.map.fromRow(r, row)));
  }

  // ---------------------------------------------------------- outbox dispatch (M0-certified lease protocol)
  private outboxRow(r: Record<string, unknown>): OutboxRow {
    return {
      tenant: String(r["tenant"]), opId: String(r["op_id"]), ordinal: Number(r["ordinal"]), channel: String(r["channel"]), message: String(r["message"]),
      payload: JSON.parse(String(r["payload"])), createdAt: String(r["created_at"]), status: r["status"] as OutboxRow["status"], attempts: Number(r["attempts"]),
      ...(r["trace"] ? { trace: JSON.parse(String(r["trace"])) as NonNullable<OutboxRow["trace"]> } : {}),
      leaseOwner: (r["lease_owner"] as string | null) ?? null, leaseUntil: r["lease_until"] === null || r["lease_until"] === undefined ? null : Number(r["lease_until"]),
      delivered: r["delivered"] ? (JSON.parse(String(r["delivered"])) as string[]) : [],
    };
  }
  outboxTenants(): Effect.Effect<string[], ForgeError> {
    return this.wrap(async () => (await this.db.all<{ tenant: string }>(st("SELECT DISTINCT tenant FROM forge_outbox WHERE status = 'pending' LIMIT 1000"))).map((r) => r.tenant));
  }
  outboxSweep(tenant: string, now: number, limit: number): Effect.Effect<OutboxRow[], ForgeError> {
    return this.wrap(async () => (await this.db.all(st("SELECT * FROM forge_outbox WHERE tenant = ? AND status = 'pending' AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at, op_id, ordinal LIMIT ?", tenant, now, limit))).map((r) => this.outboxRow(r)));
  }
  outboxClaim(r: { tenant: string; opId: string; ordinal: number }, owner: string, now: number, leaseMs: number): Effect.Effect<boolean, ForgeError> {
    return this.wrap(async () => (await this.db.run(st("UPDATE forge_outbox SET lease_owner = ?, lease_until = ?, attempts = attempts + 1 WHERE tenant = ? AND op_id = ? AND ordinal = ? AND status = 'pending' AND (lease_until IS NULL OR lease_until < ?)", owner, now + leaseMs, r.tenant, r.opId, r.ordinal, now))).changes === 1);
  }
  outboxProgress(r: { tenant: string; opId: string; ordinal: number }, owner: string, u: { delivered: string[]; done?: boolean; dead?: boolean; releaseLease?: boolean }): Effect.Effect<boolean, ForgeError> {
    return this.wrap(async () => {
      const cur = await this.db.first<{ delivered: string | null }>(st("SELECT delivered FROM forge_outbox WHERE tenant = ? AND op_id = ? AND ordinal = ? AND status = 'pending' AND lease_owner = ?", r.tenant, r.opId, r.ordinal, owner));
      if (!cur) return false;
      const merged = [...new Set([...(cur.delivered ? (JSON.parse(cur.delivered) as string[]) : []), ...u.delivered])];
      const status = u.done ? "delivered" : u.dead ? "dead" : "pending";
      const release = u.done || u.dead || u.releaseLease;
      const res = await this.db.run(st(`UPDATE forge_outbox SET delivered = ?, status = ?${release ? ", lease_owner = NULL, lease_until = NULL" : ""} WHERE tenant = ? AND op_id = ? AND ordinal = ? AND status = 'pending' AND lease_owner = ?`, JSON.stringify(merged), status, r.tenant, r.opId, r.ordinal, owner));
      return res.changes === 1;
    });
  }
  outboxDead(tenant: string): Effect.Effect<OutboxRow[], ForgeError> {
    return this.wrap(async () => (await this.db.all(st("SELECT * FROM forge_outbox WHERE tenant = ? AND status = 'dead' ORDER BY created_at", tenant))).map((r) => this.outboxRow(r)));
  }
  outboxRedrive(r: { tenant: string; opId: string; ordinal: number }): Effect.Effect<boolean, ForgeError> {
    return this.wrap(async () => (await this.db.run(st("UPDATE forge_outbox SET status = 'pending', attempts = 0, lease_owner = NULL, lease_until = NULL WHERE tenant = ? AND op_id = ? AND ordinal = ? AND status = 'dead'", r.tenant, r.opId, r.ordinal))).changes === 1);
  }
  markProcessed(tenant: string, subscription: string, messageId: string): Effect.Effect<boolean, ForgeError> {
    return this.wrap(async () => {
      const res = await this.db.run(st("INSERT OR IGNORE INTO forge_processed (tenant, subscription, message_id, at) VALUES (?, ?, ?, ?)", tenant, subscription, messageId, new Date().toISOString()));
      return res.changes === 1;
    });
  }

  getReceipt(tenant: string, operation: string, key: string): Effect.Effect<Receipt | null, ForgeError> {
    return this.wrap(async () => {
      const row = await this.db.first(st("SELECT * FROM forge_receipt WHERE tenant = ? AND operation = ? AND key = ?", tenant, operation, key));
      if (!row) return null;
      return { tenant, operation, key, requestHash: String(row["request_hash"]), status: Number(row["status"]), response: JSON.parse(String(row["response"])), createdAt: String(row["created_at"]) };
    });
  }

  budget(plans: CommitPlan[], absent: readonly AtomicAbsenceGuard[] = []): { actions: number; limit: number } {
    return { actions: absent.length * 2 + plans.reduce((n, p) => n + this.statementsFor(p).length, 0), limit: D1_BATCH_STATEMENT_LIMIT };
  }

  exportPage(tenant: string, r: Resource, cursor: string | null, limit: number): Effect.Effect<{ records: StoredRecord[]; next: string | null }, ForgeError> {
    const t = this.map.table(r);
    return this.wrap(async () => {
      const where = r.decorators.tenant ? "tenant = ? AND id > ?" : "id > ?";
      const bind = r.decorators.tenant ? [tenant, cursor ?? ""] : [cursor ?? ""];
      const rows = await this.db.all<Record<string, unknown>>(st(`SELECT * FROM ${t.name} WHERE ${where} ORDER BY id LIMIT ?`, ...bind, limit + 1));
      const page = rows.slice(0, limit).map((row) => this.map.fromRow(r, row));
      return { records: page, next: rows.length > limit ? String(page[page.length - 1]!["id"]) : null };
    });
  }

  getDocument(tenant: string, kind: string, id: string): Effect.Effect<Record<string, unknown> | null, ForgeError> {
    return this.wrap(async () => {
      const row = await this.db.first<{ version: number; body: string }>(st("SELECT version, body FROM forge_document WHERE tenant = ? AND kind = ? AND id = ?", tenant, kind, id));
      return row ? { ...(JSON.parse(row.body) as Record<string, unknown>), _version: row.version } : null;
    });
  }

  putDocuments(tenant: string, writes: DocumentWrite[]): Effect.Effect<void, ForgeError> {
    if (writes.length > 24 || new Set(writes.map(w=>JSON.stringify([w.kind,w.id]))).size !== writes.length) return Effect.fail(err("BudgetExceeded", "document batch must contain at most 24 distinct keys"));
    if (!writes.length) return Effect.void;
    const op = `documents:${crypto.randomUUID()}`;
    const statements: SqlStatement[] = [];
    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const w of writes) {
      conditions.push(w.expectedVersion === null ? "NOT EXISTS (SELECT 1 FROM forge_document WHERE tenant = ? AND kind = ? AND id = ?)" : "EXISTS (SELECT 1 FROM forge_document WHERE tenant = ? AND kind = ? AND id = ? AND version = ?)");
      params.push(tenant,w.kind,w.id,...(w.expectedVersion === null ? [] : [w.expectedVersion]));
    }
    statements.push(st(`INSERT INTO _forge_assert (op_id, satisfied) SELECT ?, (${conditions.join(" AND ")})`,op,...params));
    for (const w of writes) {
      const { _version, ...rest } = w.doc; void _version;
      statements.push(w.expectedVersion === null
        ? st("INSERT INTO forge_document (tenant, kind, id, version, body) VALUES (?, ?, ?, 1, ?)",tenant,w.kind,w.id,JSON.stringify(rest))
        : st("UPDATE forge_document SET version = version + 1, body = ? WHERE tenant = ? AND kind = ? AND id = ? AND version = ?",JSON.stringify(rest),tenant,w.kind,w.id,w.expectedVersion));
    }
    statements.push(st("DELETE FROM _forge_assert WHERE op_id = ?",op));
    return Effect.tryPromise({try:async()=>{await this.db.batch(statements);},catch:(e)=> /forge_precondition|UNIQUE constraint failed|database is locked/.test(String(e)) ? err("VersionConflict","document batch changed concurrently") : err("StorageUnavailable",String(e))});
  }

  putDocument(tenant: string, kind: string, id: string, doc: Record<string, unknown>, expectedVersion: number | null): Effect.Effect<void, ForgeError> {
    const { _version, ...rest } = doc as Record<string, unknown> & { _version?: unknown };
    void _version;
    const body = JSON.stringify(rest);
    return this.wrap(async () => {
      const res = expectedVersion === null
        ? await this.db.run(st("INSERT INTO forge_document (tenant, kind, id, version, body) VALUES (?, ?, ?, 1, ?)", tenant, kind, id, body)).catch(() => ({ changes: 0 }))
        : await this.db.run(st("UPDATE forge_document SET version = version + 1, body = ? WHERE tenant = ? AND kind = ? AND id = ? AND version = ?", body, tenant, kind, id, expectedVersion));
      if (res.changes !== 1) throw new Error("VersionConflict");
    }).pipe(Effect.mapError((e) => (e.detail === "VersionConflict" ? err("VersionConflict", "document changed concurrently") : e)));
  }

  commit(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    return this.commitAll([plan]);
  }

  /**
   * How many times a transient conflict is re-attempted, and how long to wait between attempts.
   * Both are overridable because the right budget is a property of the engine's concurrency
   * control, not of this protocol: a single-writer store conflicts rarely, a store using
   * serializable snapshot isolation conflicts whenever independent writers overlap.
   */
  protected readonly retryAttempts: number = RETRY_ATTEMPTS;
  protected retryDelayMs(attempt: number): number {
    return Math.floor(Math.random() * 25 * attempt);
  }

  commitAll(plans: CommitPlan[], absent: readonly AtomicAbsenceGuard[] = []): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const conflict = absenceWriteConflict(plans, absent);
      if (conflict) return yield* Effect.fail(conflict);
      for (let attempt = 1; ; attempt++) {
        const outcome = yield* self.commitOnce(plans, absent);
        if (outcome === "ok") return;
        if (outcome.code !== "TransientConflict" || attempt >= self.retryAttempts) return yield* Effect.fail(outcome);
        yield* Effect.sleep(self.retryDelayMs(attempt));
      }
    });
  }

  private commitOnce(plans: CommitPlan[], absent: readonly AtomicAbsenceGuard[]): Effect.Effect<"ok" | ForgeError, never> {
    const stmts: SqlStatement[] = [];
    const guardIds = absent.map(() => crypto.randomUUID());
    for (const [index, guard] of absent.entries()) {
      const query = this.absenceQuery(guard);
      stmts.push(st(`INSERT INTO _forge_assert (op_id, satisfied) SELECT ?, NOT EXISTS (${query.sql})`, guardIds[index], ...query.params));
    }
    stmts.push(...plans.flatMap(p => this.statementsFor(p)));
    for (const id of guardIds) stmts.push(st("DELETE FROM _forge_assert WHERE op_id = ?", id));
    return Effect.promise(async () => {
      try {
        await this.db.batch(stmts);
        return "ok" as const;
      } catch (e) {
        if (/CHECK constraint failed: forge_precondition/.test(String((e as Error)?.message ?? e))) {
          for (const guard of absent) {
            const found = await this.db.first(this.absenceQuery(guard)).catch(() => null);
            if (found) return err("VersionConflict", "Atomic absence guard failed");
          }
        }
        // Find the plan whose precondition failed: diagnose each until one explains the failure.
        for (const plan of plans) {
          const outcome = await this.classify(e, plan);
          if (outcome.code !== "TransientConflict" || plan === plans[plans.length - 1]) return outcome;
        }
        return err("TransientConflict", "batch failed");
      }
    });
  }

  private absenceQuery(guard: AtomicAbsenceGuard): SqlStatement {
    const { resource, unique, tenant, values } = guard;
    const fields = [...unique.within, ...unique.fields];
    const where = [...(resource.decorators.tenant ? ["tenant = ?"] : []), ...fields.map(f => `${this.map.column(resource, f).name} = ?`)];
    return st(`SELECT 1 FROM ${this.map.table(resource).name} WHERE ${where.join(" AND ")}`,
      ...(resource.decorators.tenant ? [tenant] : []),
      ...fields.map(f => this.map.toColumn(resource.fields.find(field => field.name === f)!, values[f])));
  }

  /** Statements for one logical command; several commands concatenate into one atomic batch. */
  private statementsFor(plan: CommitPlan): SqlStatement[] {
    const { resource: r, tenant, id } = plan;
    const stmts: SqlStatement[] = [];
    if (plan.kind === "publish") {
      const a = plan.audit;
      stmts.push(st("INSERT INTO forge_audit (tenant, op_id, resource, record_id, kind, new_version, actor, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", a.tenant, a.opId, a.resource, a.recordId, a.kind, a.newVersion, a.actor, a.at, null));
      for (const o of plan.outbox) stmts.push(st("INSERT INTO forge_outbox (tenant, op_id, ordinal, channel, message, payload, status, attempts, created_at, trace) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)", o.tenant, o.opId, o.ordinal, o.channel, o.message, JSON.stringify(o.payload), o.createdAt, o.trace ? JSON.stringify(o.trace) : null));
      if (plan.receipt) {
        const rc = plan.receipt;
        stmts.push(st("INSERT INTO forge_receipt (tenant, operation, key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rc.tenant, rc.operation, rc.key, rc.requestHash, rc.status, JSON.stringify(rc.response), rc.createdAt));
      }
      return stmts;
    }
    const t = this.map.table(r);
    const kw = this.keyWhere(r);

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
    if (plan.interval) {
      // No overlapping live row in the group may exist at commit (evaluated inside the batch).
      const { sql, binds } = this.overlapSql(r, plan.interval);
      preds.push(`NOT EXISTS (${sql.replace("SELECT *", "SELECT 1")})`);
      if (r.decorators.tenant) predBinds.push(tenant);
      predBinds.push(...binds);
    }
    if (plan.tree) {
      // The new parent must be live and none of its ancestors (as observed) may be this row; a recursive
      // CTE re-derives the chain inside the batch so a concurrent move cannot slip a cycle past us.
      const tkw = this.keyWhere(r);
      const live = r.decorators.softDelete ? " AND deleted_at IS NULL" : "";
      const tenantSql = r.decorators.tenant ? "tenant = ? AND " : "";
      preds.push(`EXISTS (SELECT 1 FROM ${t.name} WHERE ${tkw.sql}${live})`);
      predBinds.push(...tkw.bind(tenant, plan.tree.parentId));
      preds.push(`NOT EXISTS (WITH RECURSIVE up(id, parent, depth) AS (SELECT id, parent, 0 FROM ${t.name} WHERE ${tenantSql}id = ? UNION ALL SELECT n.id, n.parent, up.depth + 1 FROM ${t.name} n JOIN up ON n.id = up.parent WHERE ${tenantSql}up.depth < 64) SELECT 1 FROM up WHERE id = ?)`);
      if (r.decorators.tenant) predBinds.push(tenant);
      predBinds.push(plan.tree.parentId);
      if (r.decorators.tenant) predBinds.push(tenant);
      predBinds.push(id);
    }
    for (const d of plan.dependents) {
      const dt = this.map.table(d.resource);
      const col = this.map.column(d.resource, d.field).name;
      const live = d.resource.decorators.softDelete ? " AND deleted_at IS NULL" : "";
      const tenantSql = d.resource.decorators.tenant ? "tenant = ? AND " : "";
      preds.push(`NOT EXISTS (SELECT 1 FROM ${dt.name} WHERE ${tenantSql}${col} = ?${live})`);
      if (d.resource.decorators.tenant) predBinds.push(tenant);
      predBinds.push(id);
    }
    stmts.push(st(`INSERT INTO _forge_assert (op_id, satisfied) SELECT ?, (${preds.join(" AND ")})`, plan.opId, ...predBinds));

    // 2. record write
    const row = this.map.toRow(r, plan.after);
    if (r.decorators.tenant) row["tenant"] = tenant;
    const cols = Object.keys(row);
    if (plan.hardDelete) {
      stmts.push(st(`DELETE FROM ${t.name} WHERE ${kw.sql}`, ...kw.bind(tenant, id)));
    } else if (plan.kind === "create") {
      stmts.push(st(`INSERT INTO ${t.name} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c])));
    } else {
      const sets = cols.filter((c) => c !== "id" && c !== "tenant");
      stmts.push(st(`UPDATE ${t.name} SET ${sets.map((c) => `"${c}" = ?`).join(", ")} WHERE ${kw.sql}`, ...sets.map((c) => row[c]), ...kw.bind(tenant, id)));
    }

    // 3. audit, outbox, receipt
    const a = plan.audit;
    stmts.push(st("INSERT INTO forge_audit (tenant, op_id, resource, record_id, kind, new_version, actor, at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", a.tenant, a.opId, a.resource, a.recordId, a.kind, a.newVersion, a.actor, a.at, a.payload === undefined ? null : JSON.stringify(a.payload)));
    for (const o of plan.outbox) {
      stmts.push(st("INSERT INTO forge_outbox (tenant, op_id, ordinal, channel, message, payload, status, attempts, created_at, trace) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)", o.tenant, o.opId, o.ordinal, o.channel, o.message, JSON.stringify(o.payload), o.createdAt, o.trace ? JSON.stringify(o.trace) : null));
    }
    if (plan.receipt) {
      const rc = plan.receipt;
      stmts.push(st("INSERT INTO forge_receipt (tenant, operation, key, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", rc.tenant, rc.operation, rc.key, rc.requestHash, rc.status, JSON.stringify(rc.response), rc.createdAt));
    }
    // 4. release the assertion row
    stmts.push(st("DELETE FROM _forge_assert WHERE op_id = ?", plan.opId));
    return stmts;
  }

  /** Provider error -> stable outcome. The named CHECK identifies a failed precondition; a diagnostic read says which. */
  private async classify(e: unknown, plan: CommitPlan): Promise<ForgeError> {
    const msg = String((e as Error)?.message ?? e);
    if (/CHECK constraint failed: forge_precondition/.test(msg)) {
      const { resource: r, tenant, id } = plan;
      const t = this.map.table(r);
      const kw = this.keyWhere(r);
      const current = await this.db.first<{ version?: number }>(st(`SELECT version FROM ${t.name} WHERE ${kw.sql}`, ...kw.bind(tenant, id))).catch(() => null);
      if (plan.kind === "create" && current) return err("TransientConflict", "id collision");
      if (plan.kind !== "create") {
        if (!current) return err("NotFound", `${r.name} ${id} not found`);
        if (plan.expectedVersion !== null && current.version !== plan.expectedVersion) return err("VersionConflict", `expected version ${plan.expectedVersion}, current is ${current.version}`);
      }
      for (const g of plan.references) {
        const gt = this.map.table(g.resource);
        const gkw = this.keyWhere(g.resource);
        const live = g.resource.decorators.softDelete ? " AND deleted_at IS NULL" : "";
        const ok = await this.db.first(st(`SELECT 1 AS ok FROM ${gt.name} WHERE ${gkw.sql}${live}`, ...gkw.bind(tenant, g.id))).catch(() => null);
        if (!ok) return err("ReferenceMissing", `${g.field} does not reference a live record`);
      }
      if (plan.interval) {
        const others = await this.db.all(st(this.overlapSql(r, plan.interval).sql + " LIMIT 1", ...(r.decorators.tenant ? [tenant] : []), ...this.overlapSql(r, plan.interval).binds)).catch(() => []);
        if (others.length) return err("ValidationFailed", "interval overlaps a concurrently written record", { fields: [{ path: "effectiveFrom", code: "IntervalOverlap", message: "overlap at commit" }] });
      }
      if (plan.tree) return err("ValidationFailed", "move would create a cycle or the parent is not live", { fields: [{ path: "parent", code: "Cycle", message: "tree guard failed at commit" }] });
      if (plan.dependents.length) return err("HasDependents", `${r.name} ${id} has live dependents`);
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
