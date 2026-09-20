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
import type { AuditEntry, CommitPlan, ListQuery, OutboxEntry, Receipt, StorageAdapter, StoredRecord } from "../services.js";

export class MemoryStorage implements StorageAdapter {
  readonly name = "memory";
  private tables = new Map<string, Map<string, StoredRecord>>(); // key: tenant|resource
  private claims = new Map<string, string>(); // tenant|claimKey -> record id
  private audits: AuditEntry[] = [];
  private outbox: OutboxEntry[] = [];
  private receipts = new Map<string, Receipt>();

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

  getReceipt(tenant: string, operation: string, key: string): Effect.Effect<Receipt | null, ForgeError> {
    return Effect.succeed(this.receipts.get(`${tenant}|${operation}|${key}`) ?? null);
  }

  commit(plan: CommitPlan): Effect.Effect<void, ForgeError> {
    const table = this.table(plan.tenant, plan.resource);
    const current = table.get(plan.id) ?? null;
    // version guard, evaluated against durable state (not the engine's earlier read)
    if (plan.kind === "create") {
      if (current) return Effect.fail(err("TransientConflict", "id collision"));
    } else {
      if (!current) return Effect.fail(err("NotFound", `${plan.resource.name} ${plan.id} not found`));
      if (plan.expectedVersion !== null && current["version"] !== plan.expectedVersion) return Effect.fail(err("VersionConflict", `expected version ${plan.expectedVersion}, current is ${current["version"]}`));
    }
    // unique claims (retained by soft-deleted records)
    for (const c of plan.claims) {
      if (c.after && c.after !== c.before) {
        const holder = this.claims.get(`${plan.tenant}|${c.after}`);
        if (holder && holder !== plan.id) return Effect.fail(err("UniqueConflict", `${c.unique.fields.join(", ")} already in use`, { constraint: `${plan.resource.id}.unique.${c.unique.name}` }));
      }
    }
    // reference guards: live in the same tenant at commit time
    for (const g of plan.references) {
      const target = this.table(plan.tenant, g.resource).get(g.id);
      if (!target || target["deletedAt"]) return Effect.fail(err("ReferenceMissing", `${g.field} does not reference a live record`));
    }
    // apply
    for (const c of plan.claims) {
      if (c.before && c.before !== c.after) this.claims.delete(`${plan.tenant}|${c.before}`);
      if (c.after) this.claims.set(`${plan.tenant}|${c.after}`, plan.id);
    }
    table.set(plan.id, { ...plan.after });
    this.audits.push(plan.audit);
    this.outbox.push(...plan.outbox);
    if (plan.receipt) this.receipts.set(`${plan.tenant}|${plan.receipt.operation}|${plan.receipt.key}`, plan.receipt);
    return Effect.void;
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
