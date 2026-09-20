import type { CallContext, CallResult, Target } from "./target.js";

/**
 * Seed of the deterministic in-memory semantic model (plan §26). Today it
 * knows one hand-written resource so the runner itself can be tested; M2
 * replaces this with a model driven by DomainIR.
 */
interface CustomerRecord {
  id: string;
  version: number;
  code: string;
  name: string;
  email: string | null;
}

const SERVER_OWNED = new Set(["id", "version", "createdAt", "updatedAt", "deletedAt"]);

export class MemoryTarget implements Target {
  readonly name = "memory";
  private records = new Map<string, Map<string, CustomerRecord>>();
  private seq = 0;

  async reset(): Promise<void> {
    this.records.clear();
    this.seq = 0;
  }

  private table(tenant: string): Map<string, CustomerRecord> {
    let t = this.records.get(tenant);
    if (!t) this.records.set(tenant, (t = new Map()));
    return t;
  }

  async call(op: string, input: unknown, ctx: CallContext): Promise<CallResult> {
    const body = (input ?? {}) as Record<string, unknown>;
    const t = this.table(ctx.tenant);
    switch (op) {
      case "Customer.create": {
        const unknown = Object.keys(body).filter((k) => SERVER_OWNED.has(k) || !["code", "name", "email"].includes(k));
        if (unknown.length) return { ok: false, code: "UnknownField", detail: unknown };
        const code = String(body["code"]).trim().toUpperCase();
        for (const r of t.values()) if (r.code === code) return { ok: false, code: "UniqueConflict" };
        const rec: CustomerRecord = { id: `cus_${String(++this.seq).padStart(4, "0")}`, version: 1, code, name: String(body["name"]), email: (body["email"] as string | undefined) ?? null };
        t.set(rec.id, rec);
        return { ok: true, value: { ...rec } };
      }
      case "Customer.get": {
        const rec = t.get(String(body["id"]));
        return rec ? { ok: true, value: { ...rec } } : { ok: false, code: "NotFound" };
      }
      case "Customer.update": {
        const rec = t.get(String(body["id"]));
        if (!rec) return { ok: false, code: "NotFound" };
        const patch = (body["patch"] ?? {}) as Record<string, unknown>;
        const unknown = Object.keys(patch).filter((k) => SERVER_OWNED.has(k) || !["name", "email"].includes(k));
        if (unknown.length) return { ok: false, code: "UnknownField", detail: unknown };
        if (body["expectedVersion"] !== rec.version) return { ok: false, code: "VersionConflict" };
        if ("name" in patch) rec.name = String(patch["name"]);
        if ("email" in patch) rec.email = patch["email"] as string | null;
        rec.version += 1;
        return { ok: true, value: { ...rec } };
      }
      default:
        return { ok: false, code: "MethodNotAllowed", detail: op };
    }
  }
}
