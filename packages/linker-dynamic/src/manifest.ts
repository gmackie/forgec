// Resolves a Closure Manifest (schemas/closure-manifest.schema.json) into what the host needs per
// request: entry points by trigger, and a verified closure per entry point. Everything that can
// be checked without module bytes is checked here, when the manifest is resolved, so a broken
// manifest is refused before it serves anything. Module bytes are verified when a closure loads.
import { CLOSURE_DOMAIN, digest, MANIFEST_DOMAIN } from "./hash.ts";

export interface Binding {
  type: string;
  name: string;
}
export type Provider = { kind: "unit"; unit: string } | { kind: "runtime"; service: string };

export interface ManifestUnit {
  symbol: string;
  role: "function" | "external" | "operation" | "workflow";
  kind: "js-module" | "wasm-component" | "forge-native";
  interfaceHash: string;
  implementationHash: string;
  implementation: { module: string; export: "default"; abi: string; libraries: Record<string, string> } | { declaration: string; executor: string };
  dependencies: string[];
  imports: Array<{ capability: string; provider: Provider }>;
  bindings: Binding[];
  findings: unknown[];
}

export interface EntryPoint {
  kind: "http-route" | "queue-consumer" | "cron" | "workflow" | "workflow-step" | "durable-object";
  id: string;
  trigger: Record<string, unknown>;
  root: string | null;
  runtimeService?: string;
  closure: string[];
  closureHash: string;
  imports: Array<{ unit: string; capability: string; provider: Provider }>;
  bindings: Binding[];
  /** FORG-30 proposal: origins the closure may reach with fetch()/connect(). Absent = no network. */
  egress?: string[];
}

export interface ClosureManifest {
  version: "closure-manifest/1";
  manifestHash: string;
  package: { name: string; version: string };
  target: string;
  buildHash: string;
  toolchain: Record<string, string>;
  units: Record<string, ManifestUnit>;
  modules: Record<string, { path: string; bytes: number; sources: string[] }>;
  entryPoints: EntryPoint[];
  hostBindings: Binding[];
  uncovered: Array<{ kind: string; id: string; reason: string }>;
}

export type LinkErrorCode =
  | "UnsupportedManifest"
  | "ManifestHashMismatch"
  | "MissingUnit"
  | "MissingModule"
  | "ModuleDigestMismatch"
  | "ClosureHashMismatch"
  | "MissingLibrary"
  | "BuildMismatch"
  | "UnknownEntryPoint"
  | "UnlinkedEntryPoint"
  | "CapabilityDenied";

const STATUS: Record<LinkErrorCode, number> = {
  UnsupportedManifest: 422,
  ManifestHashMismatch: 422,
  MissingUnit: 422,
  MissingModule: 503,
  ModuleDigestMismatch: 503,
  ClosureHashMismatch: 422,
  MissingLibrary: 503,
  BuildMismatch: 503,
  UnknownEntryPoint: 404,
  UnlinkedEntryPoint: 501,
  CapabilityDenied: 403,
};

/** Every refusal the linker makes. Problems are listed, never truncated to the first. */
export class LinkError extends Error {
  readonly status: number;
  readonly code: LinkErrorCode;
  readonly problems: string[];
  constructor(code: LinkErrorCode, problems: string[]) {
    super(`${code}: ${problems.join("; ")}`);
    this.name = "LinkError";
    this.code = code;
    this.problems = problems;
    this.status = STATUS[code];
  }
  problem(): Record<string, unknown> {
    return { type: `https://forge.dev/errors/linker/${this.code}`, title: this.code, status: this.status, code: this.code, detail: this.problems.join("; "), problems: this.problems };
  }
}

interface Route {
  method: string;
  segments: Array<string | null>;
  entry: EntryPoint;
}

export interface Resolved {
  manifest: ClosureManifest;
  entries: Map<string, EntryPoint>;
  routes: Route[];
  byQueue: Map<string, EntryPoint>;
  byWorkflowClass: Map<string, EntryPoint>;
}

const splitPath = (p: string) => p.split("/").filter(Boolean);

/**
 * Checks a manifest without module bytes. Throws one LinkError carrying every problem: unknown
 * units in closures, roots outside their closure, js-module units whose module is not listed,
 * imports from units outside the closure, recomputed closure hashes and the manifest hash.
 */
export async function resolveManifest(manifest: ClosureManifest): Promise<Resolved> {
  if (manifest?.version !== "closure-manifest/1") throw new LinkError("UnsupportedManifest", [`version ${String(manifest?.version)} is not closure-manifest/1`]);
  if (manifest.target !== "cloudflare-workers") throw new LinkError("UnsupportedManifest", [`target ${manifest.target} is not cloudflare-workers`]);
  const { manifestHash, ...body } = manifest;
  const recomputed = await digest(MANIFEST_DOMAIN, body);
  if (recomputed !== manifestHash) throw new LinkError("ManifestHashMismatch", [`manifestHash ${manifestHash} does not match its content (${recomputed})`]);

  const missing: string[] = [];
  const closures: string[] = [];
  for (const [hash, u] of Object.entries(manifest.units)) {
    for (const d of u.dependencies) if (!manifest.units[d]) missing.push(`unit ${u.symbol} depends on ${d}, which is not in the manifest`);
    if (u.kind === "js-module") {
      const blob = (u.implementation as { module: string }).module;
      if (!manifest.modules[blob]) missing.push(`unit ${u.symbol} (${hash}) needs module ${blob}, which the manifest does not list`);
    } else if (u.kind === "wasm-component") {
      missing.push(`unit ${u.symbol} is a wasm-component; this linker does not load them yet`);
    }
  }
  const ids = new Set<string>();
  for (const e of manifest.entryPoints) {
    if (ids.has(e.id)) missing.push(`entry point ${e.id} is listed twice`);
    ids.add(e.id);
    const inClosure = new Set(e.closure);
    for (const h of e.closure) if (!manifest.units[h]) missing.push(`entry point ${e.id}: closure unit ${h} is not in the manifest`);
    if (e.root && !inClosure.has(e.root)) missing.push(`entry point ${e.id}: root ${e.root} is not in its closure`);
    for (const h of e.closure) for (const d of manifest.units[h]?.dependencies ?? []) if (!inClosure.has(d)) missing.push(`entry point ${e.id}: closure is not closed (${h} -> ${d})`);
    for (const i of e.imports) if (!inClosure.has(i.unit)) missing.push(`entry point ${e.id}: import ${i.capability} belongs to ${i.unit}, outside the closure`);
    const h = await digest(CLOSURE_DOMAIN, e.closure);
    if (h !== e.closureHash) closures.push(`entry point ${e.id}: closureHash ${e.closureHash} does not match its closure (${h})`);
  }
  if (missing.length) throw new LinkError("MissingUnit", missing);
  if (closures.length) throw new LinkError("ClosureHashMismatch", closures);

  const entries = new Map(manifest.entryPoints.map((e) => [e.id, e]));
  const routes: Route[] = manifest.entryPoints
    .filter((e) => e.kind === "http-route")
    .map((e) => ({ method: String(e.trigger["method"]).toUpperCase(), segments: splitPath(String(e.trigger["path"])).map((s) => (/^\{.+\}$/.test(s) ? null : s)), entry: e }));
  const byQueue = new Map(manifest.entryPoints.filter((e) => e.kind === "queue-consumer").map((e) => [String(e.trigger["queue"]), e]));
  const byWorkflowClass = new Map(manifest.entryPoints.filter((e) => e.kind === "workflow").map((e) => [String(e.trigger["className"]), e]));
  return { manifest, entries, routes, byQueue, byWorkflowClass };
}

/** The http-route entry point for a request, preferring static segments left to right. */
export function matchRoute(resolved: Resolved, method: string, pathname: string): EntryPoint | null {
  const parts = splitPath(pathname);
  let best: { route: Route; score: string } | null = null;
  for (const r of resolved.routes) {
    if (r.method !== method.toUpperCase() || r.segments.length !== parts.length) continue;
    if (!r.segments.every((s, i) => s === null || s === parts[i])) continue;
    const score = r.segments.map((s) => (s === null ? "0" : "1")).join("");
    if (!best || score > best.score) best = { route: r, score };
  }
  return best?.route.entry ?? null;
}

/** js-module units of a closure, in closure order. */
export function jsUnits(manifest: ClosureManifest, closure: string[]): Array<{ hash: string; unit: ManifestUnit; module: string; abi: string; libraries: Record<string, string> }> {
  return closure
    .map((hash) => ({ hash, unit: manifest.units[hash]! }))
    .filter(({ unit }) => unit.kind === "js-module")
    .map(({ hash, unit }) => {
      const impl = unit.implementation as { module: string; abi: string; libraries: Record<string, string> };
      return { hash, unit, module: impl.module, abi: impl.abi, libraries: impl.libraries };
    });
}
