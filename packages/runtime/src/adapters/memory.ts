/**
 * In-memory storage adapter: the deterministic semantic model every other
 * adapter is compared against (plan §26). Single-threaded, so "atomic" is
 * trivially true; the semantics (version guard, claims, references, soft
 * delete retention, ordering) are the contract.
 */
import { Effect } from "effect";
import { compareBytes, encodeIdentity } from "../codecs.js";
import { err, type ForgeError } from "../errors.js";
import type { List, Resource, Unique } from "../model.js";
import type { AuditEntry, CommitPlan, IntervalGuard, ListQuery, OutboxEntry, OutboxRow, Receipt, StorageAdapter, StoredRecord } from "../services.js";

export class MemoryStorage implements StorageAdapter {
  readonly name = "memory";
  private tables = new Map<string, Map<string, StoredRecord>>(); // key: tenant|resource
  private claims = new Map<string, string>(); // tenant|claimKey -> record id
  private audits: AuditEntry[] = [];
  private outbox: OutboxRow[] = [];
  private processed = new Set<string>();
  private receipts = new Map<string, Receipt>();
  private documents = new Map<string, { version: number; doc: Record<string, unknown> }>();

  private table(tenant: string, r: Resource): Map<string, StoredRecord> {
    const k = `${tenant}|${r.id}`;
    let t = this.tables.get(k);
    if (!t) this.tables.set(k, (t = new Map()));
    return t;
  }

  get(tenant: string, r: Resource, id: string): Effect.Effect<StoredRecord | null, ForgeError> {
    const rec = this.table(tenant, r).get(id);
    return Effect.succeed(rec ? { ...rec } : null);
  }

  findUnique(tenant: string, r: Resource, _u: Unique, claimKey: string, _values: Record<string, unknown>): Effect.Effect<StoredRecord | null, ForgeError> {
    const id = this.claims.get(`${tenant}|${claimKey}`);
    return this.get(tenant, r, id ?? "");
  }

  list(tenant: string, r: Resource, q: ListQuery, sortKeys: (rec: StoredRecord) => string[]): Effect.Effect<{ records: StoredRecord[]; hasMore: boolean }, ForgeError> {
    const l: List = q.list;
    const rows = [...this.table(tenant, r).values()].filter((rec) => !rec["deletedAt"] && l.fields.every((f) => rec[f] === q.values[f]));
    const keyed = rows.map((rec) => ({ rec, k: sortKeys(rec), id: String(rec["id"]) }));
    const dirs = l.order.map((o) => (o.direction === "desc" ? -1 : 1));
    const cmp = (a: { k: string[]; id: string }, b: { k: string[]; id: string }) => {
      for (let i = 0; i < a.k.length; i++) {
        const c = compareBytes(a.k[i]!, b.k[i]!) * (dirs[i] ?? 1);
        if (c !== 0) return c;
      }
      return compareBytes(a.id, b.id);
    };
    keyed.sort(cmp);
    let start = 0;
    if (q.after) {
      const after = { k: q.after.keys, id: q.after.id };
      start = keyed.findIndex((x) => cmp(x, after) > 0);
      if (start < 0) start = keyed.length;
    }
    const page = keyed.slice(start, start + q.limit);
    return Effect.succeed({ records: page.map((x) => ({ ...x.rec })), hasMore: start + q.limit < keyed.length });
  }

  countDependents(tenant: string, child: Resource, field: string, id: string): Effect.Effect<number, ForgeError> {
    let n = 0;
    for (const rec of this.table(tenant, child).values()) if (!rec["deletedAt"] && rec[field] === id) n++;
    return Effect.succeed(n);
  }

  getReceipt(tenant: string, operation: string, key: string): Effect.Effect<Receipt | null, ForgeError> {
    return Effect.succeed(this.receipts.get(`${tenant}|${operation}|${key}`) ?? null);
  }

  private overlapSync(tenant: string, r: Resource, g: IntervalGuard): StoredRecord[] {
    const out: StoredRecord[] = [];
    for (const rec of this.table(tenant, r).values()) {
      if (rec["deletedAt"] || rec["id"] === g.excludeId) continue;
      if (!g.groupFields.every((f, i) => rec[f] === g.groupValues[i])) continue;
      const from = String(rec["effectiveFrom"]);
      const until = (rec["effectiveUntil"] as string | null) ?? null;
      // half-open intervals overlap iff a.from < b.until && b.from < a.until (null until = +inf)
      const aBeforeBEnd = until === null || g.from < until;
      const bBeforeAEnd = g.until === null || from < g.until;
      if (aBeforeBEnd && bBeforeAEnd) out.push({ ...rec });
    }
    return out;
  }
  overlapping(tenant: string, r: Resource, g: IntervalGuard): Effect.Effect<StoredRecord[], ForgeError> {
    return Effect.succeed(this.overlapSync(tenant, r, g));
  }
  effectiveAt(tenant: string, r: Resource, groupFields: string[], groupValues: unknown[], at: string): Effect.Effect<StoredRecord | null, ForgeError> {
    for (const rec of this.table(tenant, r).values()) {
      if (rec["deletedAt"]) continue;
      if (!groupFields.every((f, i) => rec[f] === groupValues[i])) continue;
      const from = String(rec["effectiveFrom"]);
      const until = (rec["effectiveUntil"] as string | null) ?? null;
      if (from <= at && (until === null || at < until)) return Effect.succeed({ ...rec });
    }
    return Effect.succeed(null);
  }
  children(tenant: string, r: Resource, parentField: string, id: string, limit: number): Effect.Effect<StoredRecord[], ForgeError> {
    const rows = [...this.table(tenant, r).values()].filter((x) => !x["deletedAt"] && x[parentField] === id).sort((a, b) => compareBytes(String(a["name"] ?? a["id"]), String(b["name"] ?? b["id"])) || compareBytes(String(a["id"]), String(b["id"])));
    return Effect.succeed(rows.slice(0, limit).map((x) => ({ ...x })));
  }

  private row(r: { tenant: string; opId: string; ordinal: number }): OutboxRow | undefined {
    return this.outbox.find((o) => o.tenant === r.tenant && o.opId === r.opId && o.ordinal === r.ordinal);
  }
  outboxTenants(): Effect.Effect<string[], ForgeError> {
    return Effect.succeed([...new Set(this.outbox.filter((o) => o.status === "pending").map((o) => o.tenant))]);
  }
  outboxSweep(tenant: string, now: number, limit: number): Effect.Effect<OutboxRow[], ForgeError> {
    return Effect.succeed(this.outbox.filter((o) => o.tenant === tenant && o.status === "pending" && (o.leaseUntil === null || o.leaseUntil < now)).slice(0, limit).map((o) => ({ ...o, delivered: [...o.delivered] })));
  }
  outboxClaim(r: { tenant: string; opId: string; ordinal: number }, owner: string, now: number, leaseMs: number): Effect.Effect<boolean, ForgeError> {
    const o = this.row(r);
    if (!o || o.status !== "pending" || (o.leaseUntil !== null && o.leaseUntil >= now)) return Effect.succeed(false);
    o.leaseOwner = owner;
    o.leaseUntil = now + leaseMs;
    o.attempts += 1;
    return Effect.succeed(true);
  }
  outboxProgress(r: { tenant: string; opId: string; ordinal: number }, owner: string, u: { delivered: string[]; done?: boolean; dead?: boolean; releaseLease?: boolean }): Effect.Effect<boolean, ForgeError> {
    const o = this.row(r);
    if (!o || o.status !== "pending" || o.leaseOwner !== owner) return Effect.succeed(false);
    o.delivered = [...new Set([...o.delivered, ...u.delivered])];
    if (u.done) o.status = "delivered";
    if (u.dead) o.status = "dead";
    if (u.done || u.dead || u.releaseLease) {
      o.leaseOwner = null;
      o.leaseUntil = null;
    }
    return Effect.succeed(true);
  }
  outboxDead(tenant: string): Effect.Effect<OutboxRow[], ForgeError> {
    return Effect.succeed(this.outbox.filter((o) => o.tenant === tenant && o.status === "dead").map((o) => ({ ...o })));
  }
  outboxRedrive(r: { tenant: string; opId: string; ordinal: number }): Effect.Effect<boolean, ForgeError> {
    const o = this.row(r);
    if (!o || o.status !== "dead") return Effect.succeed(false);
    o.status = "pending";
    o.attempts = 0;
    return Effect.succeed(true);
  }
  markProcessed(tenant: string, subscription: string, messageId: string): Effect.Effect<boolean, ForgeError> {
    const k = `${tenant}|${subscription}|${messageId}`;
    if (this.processed.has(k)) return Effect.succeed(false);
    this.processed.add(k);
    return Effect.succeed(true);
  }

  budget(plans: CommitPlan[]): { actions: number; limit: number } {
    // The reference model has no physical ceiling; report the portable default so previews are comparable.
    return { actions: plans.reduce((n, p) => n + 1 + p.claims.length + p.references.length + 2, 0), limit: 100 };
  }

  getDocument(tenant: string, kind: string, id: string): Effect.Effect<Record<string, unknown> | null, ForgeError> {
    const d = this.documents.get(`${tenant}|${kind}|${id}`);
    return Effect.succeed(d ? structuredClone({ ...d.doc, _version: d.version }) : null);
  }

  putDocument(tenant: string, kind: string, id: string, doc: Record<string, unknown>, expectedVersion: number | null): Effect.Effect<void, ForgeError> {
    const k = `${tenant}|${kind}|${id}`;
    const cur = this.documents.get(k);
    if ((cur?.version ?? null) !== expectedVersion) return Effect.fail(err("VersionConflict", "document changed concurrently"));
    const { _version, ...rest } = doc as Record<string, unknown> & { _version?: unknown };
    void _version;
    this.documents.set(k, { version: (cur?.version ?? 0) + 1, doc: structuredClone(rest) });
    return Effect.void;
  }

  /** Validate every plan against durable state first, then apply all: single-threaded, so atomic. */
  commitAll(plans: CommitPlan[]): Effect.Effect<void, ForgeError> {
    const snapshot = { tables: structuredClone(this.tables), claims: new Map(this.claims), audits: [...this.audits], outbox: [...this.outbox], receipts: new Map(this.receipts) };
    for (const p of plans) {
      const r = this.commitSync(p);
      if (r) {
        this.tables = snapshot.tables;
        this.claims = snapshot.claims;
        this.audits = snapshot.audits;
        this.outbox = snapshot.outbox;
        this.receipts = snapshot.receipts;
        return Effect.fail(r);
      }
    }
    return Effect.void;
  }

  commit(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    const e = this.commitSync(plan);
    return e ? Effect.fail(e) : Effect.void;
  }

  private commitSync(plan: CommitPlan): ForgeError | null {
    if (plan.kind === "publish") {
      this.audits.push(plan.audit);
      this.outbox.push(...plan.outbox.map((o: OutboxEntry): OutboxRow => ({ ...o, status: "pending", attempts: 0, leaseOwner: null, leaseUntil: null, delivered: [] })));
      if (plan.receipt) this.receipts.set(`${plan.tenant}|${plan.receipt.operation}|${plan.receipt.key}`, plan.receipt);
      return null;
    }
    const table = this.table(plan.tenant, plan.resource);
    const current = table.get(plan.id) ?? null;
    // version guard, evaluated against durable state (not the engine's earlier read)
    if (plan.kind === "create") {
      if (current) return (err("TransientConflict", "id collision"));
    } else {
      if (!current) return (err("NotFound", `${plan.resource.name} ${plan.id} not found`));
      if (plan.expectedVersion !== null && current["version"] !== plan.expectedVersion) return (err("VersionConflict", `expected version ${plan.expectedVersion}, current is ${current["version"]}`));
    }
    // unique claims (retained by soft-deleted records)
    for (const c of plan.claims) {
      if (c.after && c.after !== c.before) {
        const holder = this.claims.get(`${plan.tenant}|${c.after}`);
        if (holder && holder !== plan.id) return (err("UniqueConflict", `${c.unique.fields.join(", ")} already in use`, { constraint: `${plan.resource.id}.unique.${c.unique.name}` }));
      }
    }
    // reference guards: live in the same tenant at commit time
    for (const g of plan.references) {
      const target = this.table(plan.tenant, g.resource).get(g.id);
      if (!target || target["deletedAt"]) return (err("ReferenceMissing", `${g.field} does not reference a live record`));
    }
    // effective interval guard, re-evaluated against durable state
    if (plan.interval && this.overlapSync(plan.tenant, plan.resource, plan.interval).length) return err("ValidationFailed", "interval overlaps a concurrently written record", { fields: [{ path: "effectiveFrom", code: "IntervalOverlap", message: "overlap at commit" }] });
    // tree guard: the observed ancestor chain of the new parent must still hold and must not include this id
    if (plan.tree) {
      let cur: string | null = plan.tree.parentId;
      const seen = new Set<string>();
      for (let i = 0; i < 64 && cur; i++) {
        if (cur === plan.id) return err("ValidationFailed", "move would create a cycle", { fields: [{ path: "parent", code: "Cycle", message: "cycle at commit" }] });
        if (seen.has(cur)) return err("ValidationFailed", "cycle in hierarchy", { fields: [{ path: "parent", code: "Cycle", message: "existing cycle" }] });
        seen.add(cur);
        const rec = table.get(cur);
        if (!rec || rec["deletedAt"]) return err("ReferenceMissing", "parent is not live");
        cur = (rec[plan.tree.parentField] as string | null) ?? null;
      }
    }
    // restrict-delete guard at commit time
    for (const d of plan.dependents) {
      for (const rec of this.table(plan.tenant, d.resource).values()) {
        if (!rec["deletedAt"] && rec[d.field] === plan.id) return (err("HasDependents", `${plan.resource.name} ${plan.id} has live dependents`));
      }
    }
    // apply
    for (const c of plan.claims) {
      if (c.before && c.before !== c.after) this.claims.delete(`${plan.tenant}|${c.before}`);
      if (c.after) this.claims.set(`${plan.tenant}|${c.after}`, plan.id);
    }
    if (plan.hardDelete) table.delete(plan.id);
    else table.set(plan.id, { ...plan.after });
    this.audits.push(plan.audit);
    this.outbox.push(...plan.outbox.map((o: OutboxEntry): OutboxRow => ({ ...o, status: "pending", attempts: 0, leaseOwner: null, leaseUntil: null, delivered: [] })));
    if (plan.receipt) this.receipts.set(`${plan.tenant}|${plan.receipt.operation}|${plan.receipt.key}`, plan.receipt);
    return null;
  }

  /** Test helper. */
  async dump(tenant: string): Promise<Record<string, any[]>> {
    const out: Record<string, any[]> = { audit: this.audits.filter((a) => a.tenant === tenant), outbox: this.outbox.filter((o) => o.tenant === tenant) };
    for (const [k, t] of this.tables) {
      const [ten, res] = k.split("|");
      if (ten !== tenant) continue;
      out[res!.split("/").pop()!.toLowerCase()] = [...t.values()];
    }
    return out;
  }

  static claimKey(resource: string, unique: string, values: string[]): string {
    return encodeIdentity([resource, unique, ...values]);
  }
}
