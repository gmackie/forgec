// Seals a forgec unit plan (`forgec build --units`) into a Closure Manifest
// (schemas/closure-manifest.schema.json): bundles every js-module unit, binds the units the caller
// maps to WASM components (after checking each implements its generated WIT world), hashes implementations,
// derives unit hashes, resolves each entry point's closure and pins it with a closure hash, and
// content-addresses the result. Missing implementations and dependencies fail here, at resolve
// time, never when a request arrives.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUNDLER, bundleUnit, libraryVersion, type Finding } from "./bundle.ts";
import { CLOSURE_DOMAIN, digest, gitBlob, IMPLEMENTATION_DOMAIN, MANIFEST_DOMAIN, sha256, stableJson, UNIT_DOMAIN } from "./hash.ts";
import { locateImpl, type LocateOptions } from "./locate.ts";
import { TRANSPILER, verifyComponent } from "./wasm.ts";
import type { Lowering } from "./wit-lowering.ts";
import pkg from "../package.json" with { type: "json" };

export interface Binding {
  type: string;
  name: string;
}
type PlanProvider = { kind: "unit"; symbol: string } | { kind: "runtime"; service: string };
type Provider = { kind: "unit"; unit: string } | { kind: "runtime"; service: string };

/**
 * Where a unit comes from (FORG-33): a `.forge` declaration (planned by forgec) or an `impl/` body
 * (added here). Provenance for Loom: no unit, closure or implementation digest covers it, only
 * `manifestHash` does. A span moves when unrelated text above it changes, and a blob hash moves with
 * any edit to its file, so neither may re-identify a unit whose behaviour is unchanged.
 */
export interface SourceRef {
  part: "declaration" | "body";
  /** Package `path` is relative to, when not the manifest's own (an external's declaration). */
  package?: string;
  /** Relative to the package root, `/`-separated. */
  path: string;
  /** Byte range `[start, end)`. */
  start: number;
  end: number;
  /** `git hash-object` of the whole file. */
  gitBlob: string;
}

/** The WIT world forgec generated for an implemented function unit (FORG-31), or why there is none. */
export type PlannedWit =
  | { status: "ok"; abi: "forge-wit/1"; digest: string; world: string; lowering: Lowering }
  | { status: "unsupported"; diagnostics: Array<{ code: string; path: string; message: string }> };

export interface PlannedUnit {
  symbol: string;
  role: "function" | "external" | "operation" | "workflow" | "view" | "projection" | "cache" | "schedule" | "service";
  kind: "js-module" | "forge-native";
  interface: unknown;
  interfaceHash: string;
  implementation: { declaration: string } | { source: "impl"; binding: "function" | "external" };
  dependencies: string[];
  imports: Array<{ capability: string; provider: PlanProvider }>;
  bindings: Binding[];
  wit?: PlannedWit;
  /** `.forge` declaration spans (absent from plans written before FORG-33). */
  sources?: SourceRef[];
}

export interface UnitPlan {
  version: "unit-plan/1";
  compiler: string;
  buildHash: string;
  package: { name: string; version: string };
  target: string;
  units: PlannedUnit[];
  entryPoints: Array<{ kind: string; id: string; trigger: unknown; root?: string; runtimeService?: string; bindings: Binding[] }>;
  hostBindings: Binding[];
  uncovered: Array<{ kind: string; id: string; reason: string }>;
}

export interface SealedUnit {
  symbol: string;
  role: PlannedUnit["role"];
  kind: PlannedUnit["kind"] | "wasm-component";
  interfaceHash: string;
  implementationHash: string;
  implementation: Record<string, unknown>;
  /** Unit hashes the dependencies resolve to in this manifest; identity uses their interface hashes. */
  dependencies: string[];
  imports: Array<{ capability: string; provider: Provider }>;
  bindings: Binding[];
  findings: Finding[];
  sources: SourceRef[];
}

export interface ClosureManifest {
  version: "closure-manifest/1";
  manifestHash: string;
  package: { name: string; version: string };
  target: string;
  buildHash: string;
  toolchain: { forgec: string; bundler: string; units: string; transpiler?: string };
  units: Record<string, SealedUnit>;
  modules: Record<string, { path: string; bytes: number; sources: string[] }>;
  entryPoints: Array<{
    kind: string;
    id: string;
    trigger: unknown;
    root: string | null;
    runtimeService?: string;
    closure: string[];
    closureHash: string;
    imports: Array<{ unit: string; capability: string; provider: Provider }>;
    bindings: Binding[];
  }>;
  hostBindings: Binding[];
  uncovered: UnitPlan["uncovered"];
}

export interface Sealed {
  manifest: ClosureManifest;
  /** Module and component bytes by blob digest. */
  modules: Map<string, Uint8Array>;
  /** Unit hash by symbol, for callers that think in declarations. */
  bySymbol: Map<string, string>;
}

const sortBindings = (bs: Binding[]) => [...new Map(bs.map((b) => [`${b.type}\0${b.name}`, b])).values()].sort((a, b) => (`${a.type}\0${a.name}` < `${b.type}\0${b.name}` ? -1 : 1));

export interface SealOptions extends LocateOptions {
  executor?: string;
  /**
   * Units to bind to a WASM component instead of their impl/ module: symbol -> app-relative
   * path of the component. The component must implement the unit's generated WIT world. This is
   * the swap: the interface, and so every caller, stays the same.
   */
  components?: Record<string, string>;
}

export async function seal(plan: UnitPlan, appRoot: string, options: SealOptions = {}): Promise<Sealed> {
  if (plan.version !== "unit-plan/1") throw new Error(`unsupported unit plan ${plan.version}`);
  const sites = locateImpl(appRoot, options);
  const planned = new Map(plan.units.map((u) => [u.symbol, u]));
  const components = new Map(Object.entries(options.components ?? {}));
  for (const [symbol, file] of components) {
    const u = planned.get(symbol);
    if (!u || u.kind !== "js-module") throw new Error(`component ${file} is bound to ${symbol}, which the unit plan has no implemented function unit for`);
    if (u.wit?.status !== "ok") {
      const why = u.wit?.status === "unsupported" ? u.wit.diagnostics.map((d) => `error[${d.code}]: ${d.path}: ${d.message}`).join("; ") : "the plan has no WIT for it";
      throw new Error(`${symbol} cannot be a wasm-component: its interface has no WIT world (${why})`);
    }
    if (!existsSync(resolve(appRoot, file))) throw new Error(`component ${file} for ${symbol} does not exist`);
  }
  for (const [symbol, site] of sites) {
    const u = planned.get(symbol);
    if (!u || u.kind !== "js-module") throw new Error(`${site.file}#${site.exportName} implements ${symbol}, which the unit plan has no js-module unit for`);
  }
  const executor = options.executor ?? `@forgegraph/runtime@${libraryVersion(appRoot, "@forgegraph/runtime")}`;

  // Implementation hashes: bundle bytes for js-module, the declaration digest for forge-native.
  const modules = new Map<string, Uint8Array>();
  const moduleInfo: ClosureManifest["modules"] = {};
  const impl = new Map<string, { implementation: Record<string, unknown>; findings: Finding[] }>();
  const bodies = new Map<string, SourceRef>();
  const blobOf = (file: string) => gitBlob(new Uint8Array(readFileSync(resolve(appRoot, file))));
  const kinds = new Map<string, SealedUnit["kind"]>(plan.units.map((u) => [u.symbol, u.kind]));
  for (const u of plan.units) {
    if (u.kind === "forge-native") {
      impl.set(u.symbol, { implementation: { declaration: (u.implementation as { declaration: string }).declaration, executor }, findings: [] });
      continue;
    }
    const component = components.get(u.symbol);
    if (component) {
      const wit = u.wit as Extract<PlannedWit, { status: "ok" }>;
      const bytes = new Uint8Array(readFileSync(resolve(appRoot, component)));
      await verifyComponent(bytes, wit.world, `${component} (${u.symbol})`);
      const blob = sha256(bytes);
      modules.set(blob, bytes);
      moduleInfo[blob] = { path: `modules/${blob.slice("sha256:".length)}.wasm`, bytes: bytes.byteLength, sources: [component.split("\\").join("/")] };
      // The linker adapts the glue to wire values with the lowering, so it ships as a blob too.
      const lowering = new TextEncoder().encode(stableJson(wit.lowering));
      const lowered = sha256(lowering);
      modules.set(lowered, lowering);
      moduleInfo[lowered] = { path: `modules/${lowered.slice("sha256:".length)}.json`, bytes: lowering.byteLength, sources: [] };
      // The world digest pins the WIT the component was checked against; the bytes pin the body.
      impl.set(u.symbol, { implementation: { component: blob, world: wit.digest, lowering: lowered, abi: wit.abi }, findings: [] });
      bodies.set(u.symbol, { part: "body", path: component.split("\\").join("/"), start: 0, end: bytes.byteLength, gitBlob: gitBlob(bytes) });
      kinds.set(u.symbol, "wasm-component");
      continue;
    }
    const site = sites.get(u.symbol);
    if (!site) throw new Error(`missing unit: ${u.symbol} (${u.role}) has no implementation under impl/`);
    const m = await bundleUnit(appRoot, site);
    const blob = sha256(m.code);
    modules.set(blob, m.code);
    moduleInfo[blob] = { path: `modules/${blob.slice("sha256:".length)}.js`, bytes: m.code.byteLength, sources: m.sources };
    const abi = site.binding === "function" ? "forgegraph-function/1" : "forgegraph-external-binding/1";
    impl.set(u.symbol, { implementation: { module: blob, export: "default", abi, libraries: m.libraries }, findings: m.findings });
    bodies.set(u.symbol, { part: "body", path: site.file, start: site.start, end: site.end, gitBlob: blobOf(site.file) });
  }

  // A plan's declaration spans must still describe the files being sealed: a .forge edit after
  // `forgec build --units` would otherwise seal spans of text that no longer exists.
  for (const u of plan.units) {
    for (const s of u.sources ?? []) {
      if (s.package && s.package !== plan.package.name) continue; // another package's root: not under appRoot
      const path = resolve(appRoot, s.path);
      if (!existsSync(path)) throw new Error(`stale plan: ${u.symbol} is declared in ${s.path}, which does not exist under ${appRoot}`);
      if (blobOf(s.path) !== s.gitBlob) throw new Error(`stale plan: ${s.path} changed since forgec planned ${u.symbol}; run forgec build --units again`);
    }
  }

  // A unit's identity covers the interfaces it calls, not their implementations, so a body edit
  // re-identifies only that unit. Which implementations run is pinned per entry point by the
  // closure hash below.
  const bySymbol = new Map<string, string>();
  for (const u of plan.units) {
    const deps = u.dependencies.map((d) => {
      const dep = planned.get(d);
      if (!dep) throw new Error(`missing unit: ${u.symbol} -> ${d}`);
      return dep.interfaceHash;
    });
    const h = digest(UNIT_DOMAIN, { interface: u.interfaceHash, implementation: digest(IMPLEMENTATION_DOMAIN, impl.get(u.symbol)!.implementation), dependencies: [...deps].sort() });
    const clash = [...bySymbol].find(([, other]) => other === h);
    if (clash) throw new Error(`${u.symbol} and ${clash[0]} are the same unit (${h}); the manifest keys units by hash and cannot bind both`);
    bySymbol.set(u.symbol, h);
  }

  const units: Record<string, SealedUnit> = {};
  const provider = (p: PlanProvider): Provider => (p.kind === "unit" ? { kind: "unit", unit: bySymbol.get(p.symbol)! } : p);
  for (const u of plan.units) {
    const { implementation, findings } = impl.get(u.symbol)!;
    units[bySymbol.get(u.symbol)!] = {
      symbol: u.symbol,
      role: u.role,
      kind: kinds.get(u.symbol)!,
      interfaceHash: u.interfaceHash,
      implementationHash: digest(IMPLEMENTATION_DOMAIN, implementation),
      implementation,
      dependencies: u.dependencies.map((d) => bySymbol.get(d)!).sort(),
      imports: u.imports.map((i) => ({ capability: i.capability, provider: provider(i.provider) })),
      bindings: u.bindings,
      findings,
      sources: [...(u.sources ?? []), ...(bodies.has(u.symbol) ? [bodies.get(u.symbol)!] : [])],
    };
  }

  const closureOf = (root: string): string[] => {
    const seen = new Set<string>();
    const walk = (h: string) => {
      if (seen.has(h)) return;
      seen.add(h);
      units[h]!.dependencies.forEach(walk);
    };
    walk(root);
    return [...seen].sort();
  };
  const entryPoints: ClosureManifest["entryPoints"] = plan.entryPoints.map((e) => {
    const root = e.root ? bySymbol.get(e.root) : null;
    if (e.root && !root) throw new Error(`entry point ${e.id}: root ${e.root} is not a unit`);
    const closure = root ? closureOf(root) : [];
    const imports = closure
      .flatMap((h) => units[h]!.imports.filter((i) => i.provider.kind === "runtime").map((i) => ({ unit: h, ...i })))
      .sort((a, b) => (`${a.unit}\0${a.capability}` < `${b.unit}\0${b.capability}` ? -1 : 1));
    return {
      kind: e.kind,
      id: e.id,
      trigger: e.trigger,
      root: root ?? null,
      ...(e.runtimeService ? { runtimeService: e.runtimeService } : {}),
      closure,
      closureHash: digest(CLOSURE_DOMAIN, closure),
      imports,
      bindings: sortBindings([...e.bindings, ...closure.flatMap((h) => units[h]!.bindings)]),
    };
  });

  const body = {
    version: "closure-manifest/1" as const,
    package: plan.package,
    target: plan.target,
    buildHash: plan.buildHash,
    toolchain: { forgec: plan.compiler, bundler: BUNDLER, units: `${pkg.name}@${pkg.version}`, ...(components.size ? { transpiler: TRANSPILER } : {}) },
    units,
    modules: moduleInfo,
    entryPoints,
    hostBindings: plan.hostBindings,
    uncovered: plan.uncovered,
  };
  const manifest: ClosureManifest = { manifestHash: digest(MANIFEST_DOMAIN, body), ...body };
  return { manifest, modules, bySymbol };
}

/** Writes `manifest.json` and `modules/<sha256>.{js,wasm}`, replacing any previous modules. */
export function writeSealed(sealed: Sealed, outDir: string): void {
  rmSync(join(outDir, "modules"), { recursive: true, force: true });
  mkdirSync(join(outDir, "modules"), { recursive: true });
  for (const [blob, code] of sealed.modules) writeFileSync(join(outDir, sealed.manifest.modules[blob]!.path), code);
  writeFileSync(join(outDir, "manifest.json"), stableJson(sealed.manifest));
}
