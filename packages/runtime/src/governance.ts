/**
 * M11 runtime governance: subject location and content inspection verdicts.
 *
 * Subjects (plan §7.2, PAR-093/094): a subject is a record of a resource
 * declared `@subject(kind)`; records of resources declared `@subject(from:
 * field)` belong to the subject their field references. Location walks only
 * those declared bindings through bounded `list by` access paths, reports
 * linked subjects (a guardian shared by two students) with how many other
 * records share them, and never proposes a cascade.
 *
 * Inspection (plan §7.3, PAR-097): a verdict binds a sealed digest and
 * generation. Absent verdict = `pending`; a detector failure = `review-
 * required`; `quarantined` blocks every read; only `allowed` clears content.
 * Nothing a detector reports can lower a declared classification.
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import type { Resource } from "./model.js";
import { Clock, Storage, type RuntimeServices } from "./services.js";

const KIND = "inspection";
export type InspectionState = "pending" | "allowed" | "quarantined" | "review-required";
export interface Inspection { state: InspectionState; generation: number; digest?: string; detector?: string; detail?: string; at?: string }

export class Governance {
  /** Edition 2027 packages serve no content before an `allowed` verdict; 2026 serves `pending` (never blocked states). */
  private strict: boolean | null = null;
  constructor(private readonly engine: Engine) {}
  get strictInspection(): boolean {
    return this.strict ?? this.engine.model.bundle.ir.package.edition === "2027";
  }
  set strictInspection(v: boolean) {
    this.strict = v;
  }

  handle(action: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    switch (action) {
      case "subjects.locate": return this.locate(body, ctx);
      case "inspect": return this.inspect(body, ctx);
      default: return Effect.fail(err("MethodNotAllowed", `unknown admin action ${action}`));
    }
  }

  // ---------------------------------------------------------------- subjects
  private subjectKind(r: Resource): string | null {
    const s = r.decorators.subject;
    return s && s.binding === "kind" ? s.kind : null;
  }

  locate(body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const kind = String(body["kind"] ?? "");
      const resource = self.engine.model.resources.find((r) => r.id === body["resource"]);
      const id = String(body["id"] ?? "");
      if (!resource || self.subjectKind(resource) !== kind) {
        return yield* Effect.fail(err("ValidationFailed", `${String(body["resource"])} is not a resource of ${kind} subjects`, { fields: [{ path: "resource", code: "NotASubjectResource", message: "an organization or unbound resource is never a person subject (D21)" }] }));
      }
      const storage = yield* Storage;
      const own = yield* storage.get(ctx.tenant, resource, id);
      if (!own) return yield* Effect.fail(err("NotFound", `${resource.name} ${id} not found`));
      const records: { resource: string; count: number; via?: string }[] = [{ resource: resource.id, count: 1 }];
      // Records bound to this subject through `@subject(from: field)`.
      for (const r of self.engine.model.resources) {
        const s = r.decorators.subject;
        if (!s || s.binding !== "from") continue;
        const field = r.fields.find((f) => f.name === s.field);
        if (!field || field.type.base.kind !== "reference" || field.type.base.resource !== resource.id) continue;
        const list = r.lists.find((l) => l.fields.length === 1 && l.fields[0] === s.field);
        if (!list) continue; // compile-time E-GOV-007 guarantees a path; unknown here means an older bundle
        let count = 0;
        let cursor: unknown = null;
        for (let page = 0; page < 100; page++) {
          const p = yield* self.engine.callInternal(`${r.id}.list.${list.name}`, { params: { [s.field]: id }, limit: 100, ...(cursor ? { cursor } : {}) }, ctx);
          count += (p.items as unknown[]).length;
          cursor = p.next ?? null;
          if (!cursor) break;
        }
        records.push({ resource: r.id, count, via: s.field });
      }
      // Linked subjects: references from this subject's record to other subject resources.
      const linked: { resource: string; id: string; via: string; kind: string; sharedWith: number | null }[] = [];
      for (const f of resource.fields) {
        if (f.type.base.kind !== "reference") continue;
        const target = self.engine.model.resources.find((r) => r.id === (f.type.base as { resource: string }).resource);
        const tk = target ? self.subjectKind(target) : null;
        const value = own[f.name];
        if (!target || !tk || typeof value !== "string") continue;
        const path = resource.lists.find((l) => l.fields.length === 1 && l.fields[0] === f.name);
        let sharedWith: number | null = null;
        if (path) {
          const p = yield* self.engine.callInternal(`${resource.id}.list.${path.name}`, { params: { [f.name]: value }, limit: 100 }, ctx);
          sharedWith = (p.items as { id: string }[]).filter((x) => x.id !== id).length;
        }
        linked.push({ resource: target.id, id: value, via: f.name, kind: tk, sharedWith });
      }
      return { subject: { kind, resource: resource.id, id }, records, linked, cascade: [] };
    });
  }

  // -------------------------------------------------------------- inspection
  private docId(r: Resource, id: string): string {
    return `${r.name}:${id}`;
  }

  /** Current verdict for the record's sealed generation; absence is `pending`. */
  status(r: Resource, id: string, generation: number, ctx: CallContext): Effect.Effect<Inspection, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const doc = (yield* (yield* Storage).getDocument(ctx.tenant, KIND, self.docId(r, id))) as (Inspection & { _version?: number }) | null;
      if (!doc || doc.generation !== generation) return { state: "pending", generation };
      const { _version, ...rest } = doc;
      void _version;
      return rest;
    });
  }

  /** Gate applied by every content read (download, export). */
  checkReadable(r: Resource, id: string, generation: number, ctx: CallContext): Effect.Effect<void, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const s = yield* self.status(r, id, generation, ctx);
      if (s.state === "quarantined") return yield* Effect.fail(err("InspectionBlocked", `${r.name} ${id} content was quarantined (${s.detail ?? "inspection"})`));
      if (s.state === "review-required") return yield* Effect.fail(err("InspectionPending", `${r.name} ${id} needs review: inspection did not complete (${s.detail ?? "detector failure"})`));
      if (s.state === "pending" && self.strictInspection) return yield* Effect.fail(err("InspectionPending", `${r.name} ${id} content has not been inspected`));
    });
  }

  private inspect(body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const r = self.engine.model.resources.find((x) => x.id === body["resource"]);
      if (!r || r.kind !== "blob") return yield* Effect.fail(err("ValidationFailed", "inspection verdicts apply to blob resources"));
      const id = String(body["id"] ?? "");
      const storage = yield* Storage;
      const rec = yield* storage.get(ctx.tenant, r, id);
      if (!rec) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      if (rec["uploadState"] !== "ready") return yield* Effect.fail(err("InvalidTransition", "content is not sealed"));
      const generation = Number(rec["contentGeneration"]);
      // A verdict binds the sealed bytes: the digest must be the record's current digest.
      if (body["digest"] !== rec["digest"]) return yield* Effect.fail(err("ValidationFailed", "verdict digest does not match the sealed content", { fields: [{ path: "digest", code: "DigestMismatch", message: `sealed digest is ${String(rec["digest"])}` }] }));
      const verdict = String(body["verdict"]);
      const state: InspectionState = verdict === "allowed" ? "allowed" : verdict === "quarantined" ? "quarantined" : verdict === "failed" ? "review-required" : "review-required";
      if (!["allowed", "quarantined", "failed", "review"].includes(verdict)) return yield* Effect.fail(err("ValidationFailed", "verdict must be allowed | quarantined | failed | review"));
      const cur = (yield* storage.getDocument(ctx.tenant, KIND, self.docId(r, id))) as (Inspection & { _version?: number }) | null;
      // Quarantine is terminal for a generation: a later "allowed" from another detector cannot lift it.
      if (cur?.generation === generation && cur.state === "quarantined" && state !== "quarantined") return yield* Effect.fail(err("InvalidTransition", "quarantined content stays quarantined for this generation; upload a new version"));
      const inspection: Inspection = { state, generation, digest: String(rec["digest"]), detector: String(body["detector"] ?? "unknown"), ...(body["detail"] ? { detail: String(body["detail"]) } : {}), at: (yield* Clock).now() };
      yield* storage.putDocument(ctx.tenant, KIND, self.docId(r, id), { ...inspection }, cur?._version ?? null);
      return { id, generation, inspection };
    });
  }
}
