// Seals a forgec unit plan (`forgec build --units`) into a Closure Manifest
// (schemas/closure-manifest.schema.json): bundles every js-module unit, hashes implementations,
// derives unit hashes bottom-up through dependencies, resolves each entry point's closure, and
// content-addresses the result. Missing implementations and dependency cycles fail here, at
// resolve time, never when a request arrives.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLER, bundleUnit, libraryVersion, type Finding } from "./bundle.ts";
import { digest, IMPLEMENTATION_DOMAIN, MANIFEST_DOMAIN, sha256, stableJson, UNIT_DOMAIN } from "./hash.ts";
import { locateImpl, type LocateOptions } from "./locate.ts";
import pkg from "../package.json" with { type: "json" };

export interface Binding {
  type: string;
  name: string;
}
type PlanProvider = { kind: "unit"; symbol: string } | { kind: "runtime"; service: string };
type Provider = { kind: "unit"; unit: string } | { kind: "runtime"; service: string };

export interface PlannedUnit {
  symbol: string;
  role: "function" | "external" | "operation" | "workflow";
  kind: "js-module" | "forge-native";
  interface: unknown;
  interfaceHash: string;
  implementation: { declaration: string } | { source: "impl"; binding: "function" | "external" };
  dependencies: string[];
  imports: Array<{ capability: string; provider: PlanProvider }>;
  bindings: Binding[];
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
  kind: PlannedUnit["kind"];
  interfaceHash: string;
  implementationHash: string;
  implementation: Record<string, unknown>;
  dependencies: string[];
  imports: Array<{ capability: string; provider: Provider }>;
  bindings: Binding[];
  findings: Finding[];
}

export interface ClosureManifest {
  version: "closure-manifest/1";
  manifestHash: string;
  package: { name: string; version: string };
  target: string;
  buildHash: string;
  toolchain: { forgec: string; bundler: string; units: string };
  units: Record<string, SealedUnit>;
  modules: Record<string, { path: string; bytes: number; sources: string[] }>;
  entryPoints: Array<{
    kind: string;
    id: string;
    trigger: unknown;
    root: string | null;
    runtimeService?: string;
    closure: string[];
    imports: Array<{ unit: string; capability: string; provider: Provider }>;
    bindings: Binding[];
  }>;
  hostBindings: Binding[];
  uncovered: UnitPlan["uncovered"];
}

export interface Sealed {
  manifest: ClosureManifest;
  /** Module bytes by blob digest. */
  modules: Map<string, Uint8Array>;
  /** Unit hash by symbol, for callers that think in declarations. */
  bySymbol: Map<string, string>;
}

const sortBindings = (bs: Binding[]) => [...new Map(bs.map((b) => [`${b.type}\0${b.name}`, b])).values()].sort((a, b) => (`${a.type}\0${a.name}` < `${b.type}\0${b.name}` ? -1 : 1));

export async function seal(plan: UnitPlan, appRoot: string, options: LocateOptions & { executor?: string } = {}): Promise<Sealed> {
  if (plan.version !== "unit-plan/1") throw new Error(`unsupported unit plan ${plan.version}`);
  const sites = locateImpl(appRoot, options);
  const planned = new Map(plan.units.map((u) => [u.symbol, u]));
  for (const [symbol, site] of sites) {
    const u = planned.get(symbol);
    if (!u || u.kind !== "js-module") throw new Error(`${site.file}#${site.exportName} implements ${symbol}, which the unit plan has no js-module unit for`);
  }
  const executor = options.executor ?? `@forgegraph/runtime@${libraryVersion(appRoot, "@forgegraph/runtime")}`;

  // Implementation hashes: bundle bytes for js-module, the declaration digest for forge-native.
  const modules = new Map<string, Uint8Array>();
  const moduleInfo: ClosureManifest["modules"] = {};
  const impl = new Map<string, { implementation: Record<string, unknown>; findings: Finding[] }>();
  for (const u of plan.units) {
    if (u.kind === "forge-native") {
      impl.set(u.symbol, { implementation: { declaration: (u.implementation as { declaration: string }).declaration, executor }, findings: [] });
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
  }

  // Unit hashes bottom-up; a cycle has no well-founded hash and is refused.
  const bySymbol = new Map<string, string>();
  const visiting = new Set<string>();
  const unitHash = (symbol: string, path: string[]): string => {
    const done = bySymbol.get(symbol);
    if (done) return done;
    const u = planned.get(symbol);
    if (!u) throw new Error(`missing unit: ${path.join(" -> ")} -> ${symbol}`);
    if (visiting.has(symbol)) throw new Error(`dependency cycle: ${[...path, symbol].join(" -> ")}`);
    visiting.add(symbol);
    const deps = u.dependencies.map((d) => unitHash(d, [...path, symbol])).sort();
    visiting.delete(symbol);
    const h = digest(UNIT_DOMAIN, { interface: u.interfaceHash, implementation: digest(IMPLEMENTATION_DOMAIN, impl.get(symbol)!.implementation), dependencies: deps });
    bySymbol.set(symbol, h);
    return h;
  };
  for (const u of plan.units) unitHash(u.symbol, []);

  const units: Record<string, SealedUnit> = {};
  const provider = (p: PlanProvider): Provider => (p.kind === "unit" ? { kind: "unit", unit: bySymbol.get(p.symbol)! } : p);
  for (const u of plan.units) {
    const { implementation, findings } = impl.get(u.symbol)!;
    units[bySymbol.get(u.symbol)!] = {
      symbol: u.symbol,
      role: u.role,
      kind: u.kind,
      interfaceHash: u.interfaceHash,
      implementationHash: digest(IMPLEMENTATION_DOMAIN, implementation),
      implementation,
      dependencies: u.dependencies.map((d) => bySymbol.get(d)!).sort(),
      imports: u.imports.map((i) => ({ capability: i.capability, provider: provider(i.provider) })),
      bindings: u.bindings,
      findings,
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
      imports,
      bindings: sortBindings([...e.bindings, ...closure.flatMap((h) => units[h]!.bindings)]),
    };
  });

  const body = {
    version: "closure-manifest/1" as const,
    package: plan.package,
    target: plan.target,
    buildHash: plan.buildHash,
    toolchain: { forgec: plan.compiler, bundler: BUNDLER, units: `${pkg.name}@${pkg.version}` },
    units,
    modules: moduleInfo,
    entryPoints,
    hostBindings: plan.hostBindings,
    uncovered: plan.uncovered,
  };
  const manifest: ClosureManifest = { manifestHash: digest(MANIFEST_DOMAIN, body), ...body };
  return { manifest, modules, bySymbol };
}

/** Writes `manifest.json` and `modules/<sha256>.js`, replacing any previous modules. */
export function writeSealed(sealed: Sealed, outDir: string): void {
  rmSync(join(outDir, "modules"), { recursive: true, force: true });
  mkdirSync(join(outDir, "modules"), { recursive: true });
  for (const [blob, code] of sealed.modules) writeFileSync(join(outDir, sealed.manifest.modules[blob]!.path), code);
  writeFileSync(join(outDir, "manifest.json"), stableJson(sealed.manifest));
}
