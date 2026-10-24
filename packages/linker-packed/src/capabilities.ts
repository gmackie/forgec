// Link-time capability and binding checks. At request time the runtime grants a unit whatever its
// declaration in app.json says it uses, and the host hands the runtime whatever bindings it is given.
// The linker hands over only what the manifest declares, so it must refuse any group where the model
// would reach for more: otherwise the gap shows up as a request-time failure (or, for BLOBS and
// workflow bindings, as a silent fallback to an in-memory store or the cron timer).
import type { AppBundle } from "@forgegraph/runtime";
import { LinkError, type Manifest, type ManifestEntryPoint } from "./manifest.ts";

type Json = Record<string, unknown>;

export interface Binding {
  type: string;
  name: string;
}

/** Findings that mean a module reaches authority without a capability handle. */
export const DENIED_FINDINGS = ["raw-env", "raw-network", "platform-module", "global-scope"] as const;

/** Blob operations reach the R2 object store; without BLOBS the host would fall back to memory. */
const BLOB_KINDS = new Set(["beginUpload", "finalizeUpload", "download"]);

/** What the model grants each function: the capabilities its declaration `uses` and `sends`. */
function granted(app: AppBundle, symbol: string): string[] | null {
  const ir = app.ir as unknown as { modules: Array<{ functions?: Json[]; resources: Json[] }> };
  const decl = ir.modules.flatMap((m) => m.functions ?? []).find((f) => f["id"] === symbol);
  if (!decl) return null;
  const resources = ir.modules.flatMap((m) => m.resources);
  const out: string[] = [];
  for (const u of (decl["uses"] as Json[]) ?? []) {
    if (u["kind"] === "resource") out.push(`resource:${u["resource"]}#${u["capability"]}`);
    else if (u["kind"] === "function") out.push(`function:${u["function"]}`);
    else if (u["kind"] === "transition") {
      const r = resources.find((x) => x["id"] === u["resource"]);
      const field = (r?.["lifecycle"] as Json | undefined)?.["field"] ?? "status";
      out.push(`transition:${u["resource"]}.${field}.${u["action"]}`);
    } else out.push(`${u["kind"]}:${JSON.stringify(u)}`);
  }
  for (const s of (decl["sends"] as Json[]) ?? []) out.push(`send:${s["channel"]}#${s["message"]}`);
  return out.sort();
}

export interface CapabilityReport {
  /** Bindings the manifest declares for the group: injected, nothing else is. */
  injected: Binding[];
  /** Bindings the group's runtime needs, each checked against `injected`. */
  required: Array<Binding & { why: string }>;
  /** Declared but not needed under this group's dispatch mode (reported, still injected). */
  unused: Binding[];
  /** Gaps in what the planner declares for runtime-served entry points: reported, not refused. */
  warnings: string[];
}

export interface CheckInput {
  manifest: Manifest;
  /** The full app.json: what the runtime would grant if handed the whole model. */
  app: AppBundle;
  entryPoints: ManifestEntryPoint[];
  /** Sliced groups forward the outbox nudge, so they need no queue producers or realtime namespace. */
  dispatch: "local" | "forward";
  allowFindings?: boolean;
}

export function checkCapabilities({ manifest, app, entryPoints, dispatch, allowFindings }: CheckInput): CapabilityReport {
  const key = (b: Binding) => `${b.type}\0${b.name}`;
  const injectedMap = new Map<string, Binding>();
  for (const b of manifest.hostBindings) injectedMap.set(key(b), b);
  for (const e of entryPoints) for (const b of e.bindings) injectedMap.set(key(b), b);
  const injected = [...injectedMap.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const has = (name: string) => injected.some((b) => b.name === name);
  const required: CapabilityReport["required"] = [];
  const warnings: string[] = [];
  const need = (b: Binding, why: string, e: ManifestEntryPoint) => {
    required.push({ ...b, why });
    if (has(b.name)) return;
    if (!e.root) {
      warnings.push(`${e.id} is runtime-served and declares no ${b.type} ${b.name}, which ${why}; the planner should declare it`);
      return;
    }
    throw new LinkError("undeclared-binding", `${e.id}: ${why} needs ${b.type} ${b.name}, which the manifest does not declare for it`);
  };

  const ir = app.ir as unknown as { modules: Array<{ resources: Json[] }> };
  const opKind = new Map<string, string>();
  for (const r of ir.modules.flatMap((m) => m.resources)) for (const op of (r["operations"] as Json[]) ?? []) opKind.set(op["id"] as string, op["kind"] as string);
  const workflowPlans = ((app.workflows as { workflows?: Array<{ id: string; cloudflare: { binding: string } }> } | undefined)?.workflows ?? []);

  for (const e of entryPoints) {
    for (const b of manifest.hostBindings) need(b, "the host builds storage, auth and cursors for every request", e);
    for (const h of e.closure) {
      const u = manifest.units[h]!;
      const declared = new Set(u.imports.map((i) => i.capability));
      // 1. The model may not grant a unit anything its manifest entry does not import.
      if (u.role === "function") {
        const g = granted(app, u.symbol);
        if (!g) throw new LinkError("slice", `${u.symbol} has no function declaration in app.json`);
        for (const c of g) if (!declared.has(c)) throw new LinkError("undeclared-capability", `${u.symbol} uses ${c} (app.json) but the manifest grants it no such import`);
      }
      if (u.role === "operation") {
        const resource = u.symbol.slice(0, u.symbol.indexOf(".", u.symbol.lastIndexOf("/")));
        if (![...declared].some((c) => c.startsWith(`resource:${resource}#`) || c.startsWith(`transition:${resource}.`))) {
          throw new LinkError("undeclared-capability", `${u.symbol} runs on ${resource} but the manifest grants it no import on that resource`);
        }
        if (BLOB_KINDS.has(opKind.get(u.symbol) ?? "")) need({ type: "r2", name: "BLOBS" }, `${u.symbol} moves blob bytes (without BLOBS the host silently uses an in-memory store)`, e);
      }
      if (u.role === "workflow") {
        const plan = workflowPlans.find((w) => w.id === u.symbol);
        if (plan) need({ type: "workflow", name: plan.cloudflare.binding }, `${u.symbol} is driven by Cloudflare Workflows (without the binding the host silently falls back to the cron timer)`, e);
      }
      // 2. Every import must have a provider the linker can supply: a unit in the closure or a runtime service.
      for (const i of u.imports) {
        if (i.provider.kind === "unit" && !e.closure.includes(i.provider.unit)) throw new LinkError("unprovided-capability", `${e.id}: ${u.symbol} imports ${i.capability} from a unit outside the closure`);
      }
      // 3. Module findings that bypass capability handles.
      if (!allowFindings) {
        const bad = u.findings.filter((f) => (DENIED_FINDINGS as readonly string[]).includes(f.rule));
        if (bad.length) throw new LinkError("undeclared-capability", `${u.symbol} reaches authority outside its capability handles: ${bad.map((f) => `${f.rule} \`${f.match}\` in ${f.source}`).join(", ")}`);
      }
    }
    if (e.root === null && e.runtimeService === "workflow-instances") {
      const wf = (e.trigger as Json)["workflow"] as string;
      const plan = workflowPlans.find((w) => w.id === wf);
      if (plan && e.id.endsWith("/cancel")) need({ type: "workflow", name: plan.cloudflare.binding }, `cancelling wakes the native ${wf} instance`, e);
    }
    if (e.kind === "queue-consumer") need({ type: "queue-consumer", name: String((e.trigger as Json)["queue"]) }, "the queue delivers to this consumer", e);
    if (e.kind === "durable-object") need({ type: "durable-object", name: "REALTIME" }, "the realtime object is bound to the namespace", e);
  }

  const requiredNames = new Set(required.map((b) => b.name));
  const unused = dispatch === "forward" ? injected.filter((b) => !requiredNames.has(b.name)) : [];
  const uniq = new Map(required.map((b) => [key(b), b]));
  return { injected, required: [...uniq.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1)), unused, warnings: [...new Set(warnings)] };
}
