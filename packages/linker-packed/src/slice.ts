// Slices app.json down to what one closure group needs. The runtime executes forge-native units from
// the model, so a group cannot drop app.json altogether. It can drop every declaration its entry
// points never reach, and every section the Cloudflare host never reads.
//
// What a group needs is the reachability closure, over declaration ids, of:
//   - the resource of every operation unit, every function and workflow unit, every schedule and
//     queue subscription the group serves;
//   - the runtime's implicit reads, which no unit declares as a capability: reference checks
//     (a resource needs every resource its fields point at, and the walk follows any declaration id
//     a kept declaration mentions) and restrict-delete (a delete needs every resource that points
//     at the deleted one; engine.ts dependentsOf).
// Since FORG-33 the planner gives every runtime surface an entry point, so a group the manifest
// describes is always sliced, including the sweep (its closure is the dispatch unit: every
// projection, workflow and schedule) and the residual (no entry points: an empty slice that only
// authenticates and answers 404). Two cases still take the whole app.json:
//   - `whole`: contract metadata (/forge/discovery, openapi.json, workspace.json) publishes the
//     whole contract, so the whole model is its content, not a missing closure;
//   - `fallback`: a manifest with `uncovered` surfaces (the residual must serve them), or a sweep
//     with no root (manifests sealed before FORG-33). Reported with the reason.
// The sliced model is constructed at link time, so a slice the runtime refuses fails the link
// rather than a request.
import type { AppBundle } from "@forgegraph/runtime";
import { Model } from "@forgegraph/runtime";
import { LinkError, type Manifest, type ManifestEntryPoint } from "./manifest.ts";

type Json = Record<string, unknown>;
type Decl = { id: string } & Json;

export interface SliceSection {
  section: string;
  action: "kept" | "sliced" | "dropped";
  reason: string;
  bytesBefore: number;
  bytesAfter: number;
}

export interface SliceReport {
  /** `whole`: the entry points' content is the whole contract. `fallback`: the manifest cannot describe the group. */
  mode: "slice" | "whole" | "fallback";
  /** Why the group runs the whole app.json; absent for a slice. */
  fallbackReason?: string;
  bytesFull: number;
  bytesSlice: number;
  resources: string[];
  functions: string[];
  workflows: string[];
  channels: string[];
  sections: SliceSection[];
}

/** Sections of app.json the Cloudflare host of @forgegraph/runtime never reads in a sliced group. */
const NOT_READ: Record<string, string> = {
  dynamo: "AWS DynamoDB table plan; the Cloudflare host stores in D1",
  lineage: "build lineage; not read by the runtime",
  dataSemantics: "data classification report; not read by the runtime",
  openapi: "served only by the openapi.json metadata route, a runtime surface outside the manifest (residual group)",
  ui: "served only by the workspace.json metadata route, a runtime surface outside the manifest (residual group)",
  capabilities: "capability surfaces; empty and not read by the Cloudflare host",
};

const size = (v: unknown) => (v === undefined ? 0 : JSON.stringify(v).length);

function strings(v: unknown, out: Set<string>): Set<string> {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

export const SWEEP_SERVICE = "outbox-and-workflow-sweep";

/** Entry points whose needs the manifest does not state; these groups take the whole app.json. */
export function fallbackReason(e: ManifestEntryPoint | { kind: "residual"; id: string }, manifest: Manifest): string | null {
  if (e.kind === "residual" && manifest.uncovered.length) return `the manifest leaves ${manifest.uncovered.map((u) => `${u.kind} ${u.id}`).join(", ")} uncovered, and the residual serves them`;
  if (e.kind === "cron" && "runtimeService" in e && e.runtimeService === SWEEP_SERVICE && !e.root) return "the sweep has no root unit (a manifest sealed before FORG-33), so its closure is unknown: it delivers every outbox row to every subscription and resumes every workflow";
  return null;
}

/** Entry points whose content is the whole contract, so they take the whole app.json by design. */
export function wholeReason(e: ManifestEntryPoint | { kind: "residual"; id: string }): string | null {
  if ("runtimeService" in e && e.runtimeService === "contract-metadata") return "contract metadata (discovery, OpenAPI, record workspace) publishes the whole contract";
  return null;
}

/** Every outbox subscriber of the full app that a slice's model would not deliver to. */
export function subscriberGaps(full: AppBundle, slice: AppBundle): string[] {
  type B = { ir: { modules: Array<Record<string, unknown>> }; messaging?: { subscriptions: Array<{ name: string }> }; realtime?: { streams: Array<{ channel: string }> } };
  const ids = (b: B, k: string) => new Set(b.ir.modules.flatMap((m) => ((m[k] as Decl[] | undefined) ?? []).map((d) => d.id)));
  const [f, s] = [full as unknown as B, slice as unknown as B];
  const gaps: string[] = [];
  for (const k of ["projections", "workflows", "sources"]) for (const id of ids(f, k)) if (!ids(s, k).has(id)) gaps.push(`${k.slice(0, -1)} ${id}`);
  const subs = new Set((s.messaging?.subscriptions ?? []).map((x) => x.name));
  for (const x of f.messaging?.subscriptions ?? []) if (!subs.has(x.name)) gaps.push(`subscription ${x.name}`);
  const rts = new Set((s.realtime?.streams ?? []).map((x) => x.channel));
  for (const x of f.realtime?.streams ?? []) if (!rts.has(x.channel)) gaps.push(`realtime stream ${x.channel}`);
  return gaps;
}

export interface SliceInput {
  app: AppBundle;
  manifest: Manifest;
  entryPoints: Array<ManifestEntryPoint | { kind: "residual"; id: string }>;
}

export function sliceApp({ app, manifest, entryPoints }: SliceInput): { app: AppBundle; report: SliceReport } {
  const full = app as unknown as Json;
  const bytesFull = size(full);
  const reasons = entryPoints.map((e) => fallbackReason(e, manifest)).filter((r): r is string => !!r);
  const whole = entryPoints.map(wholeReason).filter((r): r is string => !!r);
  if (reasons.length || whole.length) {
    return {
      app,
      report: { mode: reasons.length ? "fallback" : "whole", fallbackReason: [...new Set([...reasons, ...whole])].join("; "), bytesFull, bytesSlice: bytesFull, resources: [], functions: [], workflows: [], channels: [], sections: [] },
    };
  }

  const ir = app.ir as unknown as { modules: Array<Record<string, Decl[] | unknown>> };
  const listed = (k: string) => ir.modules.flatMap((m) => (Array.isArray(m[k]) ? (m[k] as Decl[]) : []));
  const resources = listed("resources");
  const decls = new Map<string, Decl>();
  for (const k of ["resources", "functions", "channels", "views", "projections", "caches", "workflows", "sources", "shapes", "enums", "types", "subscriptions"]) {
    for (const d of listed(k)) if (typeof d.id === "string") decls.set(d.id, d);
  }
  const opResource = new Map<string, string>();
  for (const r of resources) for (const op of (r["operations"] as Decl[]) ?? []) opResource.set(op.id, r.id);

  // Roots.
  const roots = new Set<string>();
  const ops = new Set<string>();
  const subscriptions = new Set<string>();
  const extraChannels = new Set<string>();
  /** Realtime streams this group serves: the object, an upgrade route, or the dispatcher fanning out. */
  const streams = new Set<string>();
  let deletes = false;
  const messagingPlan = (app as unknown as { messaging?: { subscriptions: Array<{ name: string; channel: string }> } }).messaging;
  const units = new Set(entryPoints.flatMap((e) => ("closure" in e ? e.closure : [])));
  for (const h of units) {
    const u = manifest.units[h]!;
    if (u.role === "operation") {
      const r = opResource.get(u.symbol);
      if (!r) throw new LinkError("slice", `operation unit ${u.symbol} has no operation in app.json`);
      roots.add(r);
      ops.add(u.symbol);
      if (/\.delete$/.test(u.symbol)) deletes = true;
    } else if (["function", "workflow", "view", "projection", "cache", "schedule"].includes(u.role)) {
      if (!decls.has(u.symbol)) throw new LinkError("slice", `${u.role} unit ${u.symbol} has no declaration in app.json`);
      roots.add(u.symbol);
    }
    // The dispatcher delivers to queue subscriptions and realtime streams (`deliver:` imports).
    for (const i of u.imports) {
      if (!i.capability.startsWith("deliver:")) continue;
      const target = i.capability.slice("deliver:".length);
      if (target.startsWith("realtime:")) {
        streams.add(target.slice("realtime:".length));
        roots.add(target.slice("realtime:".length));
        continue;
      }
      const sub = messagingPlan?.subscriptions.find((x) => x.name === target);
      if (!sub) throw new LinkError("slice", `${u.symbol} delivers to subscription ${target}, which app.json does not plan`);
      subscriptions.add(sub.name);
      roots.add(sub.channel);
    }
    // External units are bodies behind an interface from another package; service units are the
    // runtime's: neither adds a declaration, only the units they reach do.
  }
  for (const e of entryPoints) {
    if (!("trigger" in e)) continue;
    const t = e.trigger as Json;
    if (typeof t["workflow"] === "string") roots.add(t["workflow"]);
    if (typeof t["schedule"] === "string") roots.add(t["schedule"]);
    if (t["upgrade"] === "websocket" && typeof t["channel"] === "string") {
      streams.add(t["channel"]);
      roots.add(t["channel"]);
    }
    if (e.kind === "cron" && decls.has(e.id)) roots.add(e.id);
    if (e.kind === "queue-consumer") {
      subscriptions.add(e.id);
      if (typeof t["channel"] === "string") roots.add(t["channel"]);
    }
    if (e.kind === "durable-object")
      for (const s of (t["streams"] as string[]) ?? []) {
        streams.add(s);
        roots.add(s);
      }
  }

  // Reachability over declaration ids, plus restrict-delete dependents.
  const kept = new Set<string>();
  const walk = (id: string) => {
    if (kept.has(id) || !decls.has(id)) return;
    kept.add(id);
    for (const s of strings(decls.get(id), new Set())) if (s !== id && decls.has(s)) walk(s);
  };
  roots.forEach(walk);
  if (deletes) {
    const deleted = [...units].map((h) => manifest.units[h]!).filter((u) => u.role === "operation" && /\.delete$/.test(u.symbol)).map((u) => opResource.get(u.symbol)!);
    for (const r of resources) {
      const fields = (r["fields"] as Array<{ type: { base: { kind: string; resource?: string } } }>) ?? [];
      if (fields.some((f) => f.type.base.kind === "reference" && deleted.includes(f.type.base.resource!))) walk(r.id);
    }
  }
  const keptResources = resources.filter((r) => kept.has(r.id)).map((r) => r.id);
  for (const r of resources) if (kept.has(r.id) && (r["decorators"] as Json)?.["audited"]) extraChannels.add(`${r.id}.changes`);
  const keptChannels = new Set([...listed("channels").filter((c) => kept.has(c.id)).map((c) => c.id), ...extraChannels]);

  // ir: every declaration list filtered to the kept ids.
  const sections: SliceSection[] = [];
  const record = (section: string, before: unknown, after: unknown, action: SliceSection["action"], reason: string) =>
    sections.push({ section, action, reason, bytesBefore: size(before), bytesAfter: size(after) });
  const slicedIr = {
    ...app.ir,
    modules: ir.modules.map((m) => {
      const out: Json = {};
      for (const [k, v] of Object.entries(m)) out[k] = Array.isArray(v) && v.every((d) => d && typeof d === "object" && typeof (d as Decl).id === "string") ? (v as Decl[]).filter((d) => kept.has(d.id)) : v;
      return out;
    }),
  };
  record("ir", app.ir, slicedIr, "sliced", "declarations reachable from the group's units, plus restrict-delete dependents");

  const out: Json = {};
  for (const [k, v] of Object.entries(full)) {
    if (k === "ir") {
      out[k] = slicedIr;
      continue;
    }
    if (NOT_READ[k] !== undefined) {
      record(k, v, undefined, "dropped", NOT_READ[k]!);
      continue;
    }
    switch (k) {
      case "contracts": {
        const c = v as Json;
        const keep = (xs: unknown) => (Array.isArray(xs) ? (xs as Decl[]).filter((d) => kept.has(d.id)) : xs);
        const next = { ...c, resources: keep(c["resources"]), functions: keep(c["functions"]), views: keep(c["views"]), projections: keep(c["projections"]), caches: keep(c["caches"]), workflows: keep(c["workflows"]), schedules: Array.isArray(c["schedules"]) ? (c["schedules"] as Array<Json>).filter((s) => kept.has(String(s["source"] ?? s["id"]))) : c["schedules"] };
        out[k] = next;
        record(k, v, next, "sliced", "wire contracts of kept declarations");
        break;
      }
      case "sql": {
        const s = v as { tables: Array<{ name: string; resource: string }>; indexes?: Array<{ table: string }>; [x: string]: unknown };
        const tables = s.tables.filter((t) => kept.has(t.resource));
        const names = new Set(tables.map((t) => t.name));
        const next = { ...s, tables, ...(s.indexes ? { indexes: s.indexes.filter((i) => names.has(i.table)) } : {}) };
        out[k] = next;
        record(k, v, next, "sliced", "tables of kept resources; system tables kept (outbox, audit, idempotency, ...)");
        break;
      }
      case "messaging": {
        const m = v as { channels: Decl[]; subscriptions: Array<{ name: string; channel: string }>; senders?: Array<Json>; [x: string]: unknown };
        const next = {
          ...m,
          channels: m.channels.filter((c) => keptChannels.has(c.id)),
          subscriptions: m.subscriptions.filter((s) => subscriptions.has(s.name)),
          ...(m.senders ? { senders: m.senders.filter((s) => [...strings(s, new Set())].some((x) => keptChannels.has(x))) } : {}),
        };
        out[k] = next;
        record(k, v, next, "sliced", "channels kept declarations publish to (incl. <Resource>.changes); only the subscriptions this group consumes. Delivery to the rest is the dispatch owner's job");
        break;
      }
      case "observability": {
        const o = v as { operations: Array<{ operation: string }>; [x: string]: unknown };
        const next = { ...o, operations: o.operations.filter((p) => kept.has(p.operation) || ops.has(p.operation) || kept.has(opResource.get(p.operation) ?? "")) };
        out[k] = next;
        record(k, v, next, "sliced", "SLO plans of operations on kept declarations");
        break;
      }
      case "workflows": {
        const w = v as { workflows: Decl[]; [x: string]: unknown };
        const next = { ...w, workflows: w.workflows.filter((x) => kept.has(x.id)) };
        out[k] = next;
        record(k, v, next, "sliced", "kept workflows' provider plans");
        break;
      }
      case "schedules": {
        const s = v as { schedules: Array<{ source: string; cloudflare?: { cron?: string } }>; cloudflareCrons?: string[]; [x: string]: unknown };
        const schedules = s.schedules.filter((x) => kept.has(x.source));
        const next = { ...s, schedules, ...(s.cloudflareCrons ? { cloudflareCrons: s.cloudflareCrons.filter((c) => schedules.some((x) => x.cloudflare?.cron === c)) } : {}) };
        out[k] = next;
        record(k, v, next, "sliced", "kept schedules");
        break;
      }
      case "realtime": {
        // Streams are read by the realtime object, the upgrade route and the dispatcher's fan-out;
        // publishing reaches them through the outbox, which the dispatch owner sweeps.
        const r = v as { streams: Array<{ channel: string }>; [x: string]: unknown };
        const kept = r.streams.filter((s) => streams.has(s.channel));
        const next = kept.length ? { ...r, streams: kept } : undefined;
        if (next) out[k] = next;
        record(k, v, next, next ? "sliced" : "dropped", "streams this group's object, upgrade route or dispatcher serves");
        break;
      }
      default:
        out[k] = v;
        record(k, v, v, "kept", "small or global (build identity, digests)");
    }
  }

  const sliced = out as unknown as AppBundle;
  try {
    new Model(sliced);
  } catch (e) {
    throw new LinkError("slice", `the runtime refuses the slice for ${entryPoints.map((x) => x.id).join(", ")}: ${(e as Error).message}`);
  }
  // The dispatch owner marks an outbox row done after the subscribers its model knows, so its slice
  // must know every one, or deliveries are dropped silently (T3, host-dispatch.test.ts).
  if (entryPoints.some((e) => "runtimeService" in e && e.runtimeService === SWEEP_SERVICE)) {
    const missing = subscriberGaps(app, sliced);
    if (missing.length) throw new LinkError("slice", `the dispatch owner's slice lacks subscribers the full app has: ${missing.join(", ")}`);
  }
  return {
    app: sliced,
    report: {
      mode: "slice",
      bytesFull,
      bytesSlice: size(sliced),
      resources: keptResources,
      functions: listed("functions").filter((f) => kept.has(f.id)).map((f) => f.id),
      workflows: listed("workflows").filter((f) => kept.has(f.id)).map((f) => f.id),
      channels: [...keptChannels].sort(),
      sections,
    },
  };
}
