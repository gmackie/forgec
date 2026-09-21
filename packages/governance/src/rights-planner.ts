/**
 * Subject inventory and reviewed disposition planning (FORGE-077; PAR-156/157).
 * From the runtime's subject location (declared bindings only), the data
 * semantics (which fields are personal, which are structural) and the lineage
 * plan (which operations publish, export or reach external sinks), produce a
 * plan a reviewer can read: per record set, what would be erased, restricted
 * or exported; what is preserved because it belongs to another subject or sits
 * under a lawful hold; and what is unknown (unmodeled egress, external sinks
 * without an erasure adapter). The verdict is `complete` only when nothing is
 * unknown and nothing external is outstanding.
 */
import { Effect } from "effect";
import type { CallContext, Engine } from "@forgegraph/runtime";

export type Disposition = "erasure" | "restriction" | "export";
export interface Hold { id: string; resource?: string; reason: string; until?: string }
export interface ExternalProcessor { id: string; sinks: string[]; erasureAdapter: boolean }
export interface PlanItem {
  resource: string;
  action: "erase-fields" | "delete-record" | "restrict" | "export" | "preserve";
  count: number;
  /** Personal fields touched (erase/export); structural fields are never in this list. */
  fields: string[];
  via?: string;
  reason: string;
  hold?: string;
}
export interface Unknown { kind: "unmodeled-egress" | "external-sink-without-adapter" | "coverage" | "linked-subject"; subject: string; detail: string }
export interface DispositionPlan {
  version: "disposition-plan/1";
  subject: { kind: string; resource: string; id: string; token: string };
  disposition: Disposition;
  items: PlanItem[];
  preserved: { resource: string; id?: string; reason: string }[];
  unknowns: Unknown[];
  external: { processor: string; sinks: string[]; state: "requested" | "accepted" | "confirmed" | "not-requested"; erasureAdapter: boolean }[];
  verdict: "complete" | "partial" | "unknown";
  requiresReview: boolean;
}

interface Semantics { fields: { resource: string; field: string; class: string; personal: string; handling: string }[]; subjects: { resource: string; kind: string; via?: string }[] }
interface Lineage { operations: { operation: string; kind: string; resource?: string; externalSinks: string[]; publishes: string[]; coverage: string }[] }

export async function planDisposition(engine: Engine, o: { subject: { kind: string; resource: string; id: string }; disposition: Disposition; holds?: Hold[]; processors?: ExternalProcessor[]; ctx: CallContext }): Promise<DispositionPlan> {
  const located = (await Effect.runPromise(engine.call("admin.subjects.locate".replace(/^/, `${engine.model.bundle.ir.package.name}/_/`), { kind: o.subject.kind, resource: o.subject.resource, id: o.subject.id }, o.ctx) as Effect.Effect<Record<string, unknown>, never, never>)) as { records: { resource: string; count: number; via?: string }[]; linked: { resource: string; id: string; via: string; kind: string; sharedWith: number | null }[] };
  const sem = engine.model.bundle.dataSemantics as unknown as Semantics | undefined;
  const lineage = engine.model.bundle.lineage as Lineage | undefined;
  const personalFields = (resource: string) => (sem?.fields ?? []).filter((f) => f.resource === resource && f.personal !== "no" && f.class !== "data.structural").map((f) => f.field);
  const items: PlanItem[] = [];
  const preserved: DispositionPlan["preserved"] = [];
  const unknowns: Unknown[] = [];
  const holds = o.holds ?? [];
  for (const r of located.records) {
    const hold = holds.find((h) => !h.resource || h.resource === r.resource);
    const fields = personalFields(r.resource);
    if (o.disposition === "export") {
      items.push({ resource: r.resource, action: "export", count: r.count, fields, ...(r.via ? { via: r.via } : {}), reason: "subject access: personal fields of the subject's own records" });
      continue;
    }
    if (hold && o.disposition === "erasure") {
      items.push({ resource: r.resource, action: "preserve", count: r.count, fields: [], ...(r.via ? { via: r.via } : {}), reason: `lawful hold ${hold.id}: ${hold.reason}`, hold: hold.id });
      preserved.push({ resource: r.resource, reason: `hold ${hold.id}` });
      continue;
    }
    if (o.disposition === "restriction") {
      items.push({ resource: r.resource, action: "restrict", count: r.count, fields, ...(r.via ? { via: r.via } : {}), reason: "processing restricted: reads outside maintenance are refused" });
      continue;
    }
    // erasure: the subject's own record is deleted; bound records keep their structure but lose the subject's personal fields
    const own = r.resource === o.subject.resource;
    items.push({ resource: r.resource, action: own ? "delete-record" : "erase-fields", count: r.count, fields, ...(r.via ? { via: r.via } : {}), reason: own ? "the subject's own record" : `bound to the subject through \`${r.via}\`: personal fields erased, structural fields kept for other subjects and integrity` });
  }
  // Linked subjects are other people: preserved, and shared links are flagged for review, never cascaded.
  for (const l of located.linked) {
    preserved.push({ resource: l.resource, id: l.id, reason: `linked ${l.kind} via \`${l.via}\`${l.sharedWith ? `, shared with ${l.sharedWith} other record(s)` : ""}: another subject's data is never erased by this request` });
    if (l.sharedWith === null) unknowns.push({ kind: "linked-subject", subject: `${l.resource}#${l.id}`, detail: "no declared access path to count other records sharing this subject" });
  }
  // Egress: operations touching the subject's resources that publish, export or reach sinks, and anything unmodeled.
  const touched = new Set(located.records.map((r) => r.resource));
  const processors = o.processors ?? [];
  const externalSinks = new Set<string>();
  for (const op of lineage?.operations ?? []) {
    if (op.resource && !touched.has(op.resource)) continue;
    if (op.coverage !== "modeled") unknowns.push({ kind: "unmodeled-egress", subject: op.operation, detail: `coverage ${op.coverage}: handwritten code may export or forward subject data; a resolver review is required` });
    for (const s of op.externalSinks) externalSinks.add(s);
  }
  const external: DispositionPlan["external"] = [];
  for (const sink of externalSinks) {
    const p = processors.find((x) => x.sinks.includes(sink));
    if (!p) unknowns.push({ kind: "external-sink-without-adapter", subject: sink, detail: "data reached an external destination with no registered processor/erasure adapter" });
    else if (!external.some((e) => e.processor === p.id)) external.push({ processor: p.id, sinks: p.sinks, state: "not-requested", erasureAdapter: p.erasureAdapter });
    if (p && !p.erasureAdapter) unknowns.push({ kind: "external-sink-without-adapter", subject: p.id, detail: "processor registered without an erasure adapter: completion can only be attested externally" });
  }
  const verdict: DispositionPlan["verdict"] = unknowns.length ? "unknown" : external.length || preserved.some((p) => p.reason.startsWith("hold")) ? "partial" : "complete";
  return {
    version: "disposition-plan/1",
    subject: { ...o.subject, token: engine.suppression.token(o.ctx.tenant, o.subject.resource, o.subject.id) },
    disposition: o.disposition,
    items,
    preserved,
    unknowns,
    external,
    verdict,
    requiresReview: true,
  };
}
