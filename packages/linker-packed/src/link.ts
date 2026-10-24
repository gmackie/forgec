// Linker A (packed). Sealed Closure Manifest in, Worker scripts out: one script per closure group,
// each carrying only its group's unit modules, a slice of app.json and the thin host (host.ts).
// Per-entry-point output also gets a router script (service bindings only, no runtime), because
// Cloudflare route patterns cannot express `{param}` segments mid-path or tell methods apart.
//
// Output layout (`out/`):
//   link.json                  the deployment: manifest hash, scripts, their hashes and sizes
//   <script>/entry.mjs         generated entry: imports the host, the slice and the unit modules
//   <script>/app.slice.json    the group's app.json (or the full one, marked fallback in link.json)
//   <script>/units/<hex>.js    unit module blobs, byte-identical to the manifest's
//   <script>/wrangler.jsonc    the script's own bindings, projected from the app's environment
//   <script>/worker.js         the bundle that would be uploaded
// Deploying a link means uploading the scripts whose `scriptHash` changed and making the manifest
// hash live; nothing in a script refers to another script except by service binding name.
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { AppBundle } from "@forgegraph/runtime";
import { sha256, stableJson } from "@forgegraph/units";
import { checkCapabilities, type Binding, type CapabilityReport } from "./capabilities.ts";
import { LinkError, loadManifest, type Manifest, type ManifestEntryPoint } from "./manifest.ts";
import { sliceApp, type SliceReport } from "./slice.ts";
import { featureSource, featuresFor } from "./features.ts";
import { applyPlatformRules, RESIDUAL, scriptName, STRATEGIES, type GroupingStrategy, type Member } from "./strategies.ts";
import type { HostConfig, HostRoute } from "./host.ts";
import pkg from "../package.json" with { type: "json" };

/** Binding types that appear in `env`; cron and queue-consumer are triggers, not handles. */
const ENV_BINDINGS = new Set(["d1", "r2", "secret", "var", "queue-producer", "durable-object", "workflow"]);
/**
 * Handle bindings the runtime probes for presence and would silently do without; withheld ones get a
 * refusing stub (FORG-34). The realtime namespace is left absent: a script without it answers a
 * websocket upgrade 404, and fan-out runs in the dispatch owner.
 */
const STUBBED_BINDINGS = new Set(["r2", "queue-producer", "workflow"]);
const withheldFrom = (declared: Binding[], injected: Binding[]) =>
  declared
    .filter((b) => STUBBED_BINDINGS.has(b.type) && !injected.some((i) => i.name === b.name))
    .map((b) => ({ type: b.type, name: b.name }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));

export const LINKER = `${pkg.name}@${pkg.version}`;
const HOST = resolve(import.meta.dirname, "host.ts");

export interface Environment {
  /** The app's whole-app wrangler config: binding names mapped to concrete resources. */
  compatibility_date: string;
  compatibility_flags?: string[];
  vars?: Record<string, string>;
  d1_databases?: Array<{ binding: string; database_name: string; database_id: string; migrations_dir?: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
  workflows?: Array<{ name: string; binding: string; class_name: string }>;
  queues?: { producers?: Array<{ binding: string; queue: string }>; consumers?: Array<Record<string, unknown> & { queue: string }> };
  triggers?: { crons?: string[] };
}

export interface LinkOptions {
  /** Directory holding the sealed `manifest.json` and `modules/`. */
  manifestDir: string;
  /** App root: `generated/app.json` and the node_modules the unit modules import from. */
  app: string;
  strategy: GroupingStrategy | string;
  out: string;
  /** Whole-app wrangler config (JSONC) supplying concrete resource names. */
  environment: string;
  /** An in-memory manifest to verify against `manifestDir`'s modules instead of `manifest.json`. */
  manifest?: Manifest;
  /** `full`: every group gets the whole app.json (to compare against slicing). */
  appJson?: "slice" | "full";
  minify?: boolean;
  allowFindings?: boolean;
  /** Skip esbuild (link-time checks only). */
  bundle?: boolean;
}

export interface LinkedScript {
  name: string;
  members: string[];
  entryPoints: Array<{ id: string; kind: string; closureHash: string | null }>;
  units: string[];
  modules: string[];
  routes: HostRoute[] | null;
  deny: HostRoute[];
  crons: string[];
  queues: string[];
  classes: { workflows: Array<{ className: string; workflow: string }>; realtime: string | null };
  dispatch: "local" | "forward";
  dispatchOwner: boolean;
  slice: SliceReport;
  capabilities: CapabilityReport;
  /** Bindings declared for other scripts: the runtime here holds a stub that refuses them (403 CapabilityDenied). */
  withheld: Binding[];
  /** Runtime features linked into the script (FORG-37): its slice's, or every feature for a fallback group. */
  features: { mode: "all" | "slice"; names: string[] };
  /** Linker-owned bindings (not capabilities of any unit): the dispatch service binding. */
  linkerBindings: Array<Binding & { script: string }>;
  /** sha256 of worker.js: a script is re-uploaded exactly when this changes. */
  scriptHash: string | null;
  bytes: { raw: number; gzip: number } | null;
  /** Bytes in the bundle by origin. */
  composition: Record<string, number> | null;
}

export interface Link {
  version: "packed-link/1";
  linker: string;
  manifestHash: string;
  package: { name: string; version: string };
  strategy: string;
  compatibilityDate: string;
  scripts: LinkedScript[];
  router: { name: string; scriptHash: string | null; bytes: { raw: number; gzip: number } | null; table: Array<HostRoute & { script: string }>; fallback: string } | null;
  /** What a deploy flips: the manifest hash that is live once these scripts are uploaded. */
  live: string;
}

/** JSONC → JSON: drops comments outside strings. */
export function readJsonc(path: string): unknown {
  const text = readFileSync(path, "utf8");
  let out = "";
  for (let i = 0, str = false; i < text.length; i++) {
    const c = text[i]!;
    if (str) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') str = false;
    } else if (c === '"') {
      str = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const routeOf = (e: ManifestEntryPoint): HostRoute | null => {
  if (e.kind !== "http-route") return null;
  const t = e.trigger as { method: string; path: string };
  return { method: t.method, path: t.path };
};

export async function link(options: LinkOptions): Promise<Link> {
  const strategy = typeof options.strategy === "string" ? STRATEGIES[options.strategy] : options.strategy;
  if (!strategy) throw new Error(`unknown strategy ${String(options.strategy)} (have ${Object.keys(STRATEGIES).join(", ")})`);
  const { manifest, modules } = loadManifest(options.manifestDir, options.manifest);
  const app = JSON.parse(readFileSync(join(options.app, "generated/app.json"), "utf8")) as AppBundle;
  if (app.buildHash !== manifest.buildHash) throw new LinkError("manifest-hash", `app.json is build ${app.buildHash} but the manifest was sealed from build ${manifest.buildHash}`);
  const env = readJsonc(options.environment) as Environment;

  const members: Member[] = [...manifest.entryPoints, RESIDUAL];
  const byId = new Map(members.map((m) => [m.id, m]));
  const groups = applyPlatformRules(strategy.group(members, manifest), members);
  const allRoutes = manifest.entryPoints.map(routeOf).filter((r): r is HostRoute => !!r);
  const declaredAll = (() => {
    const m = new Map<string, Binding>();
    for (const b of manifest.hostBindings) m.set(b.name, b);
    for (const e of manifest.entryPoints) for (const b of e.bindings) m.set(b.name, b);
    return [...m.values()];
  })();

  // Pass 1: decide every group (slice, capabilities, dispatch mode) before emitting anything.
  const planned = groups.map((ids) => {
    const ms = ids.map((id) => byId.get(id)!);
    const eps = ms.filter((m): m is ManifestEntryPoint => m.kind !== "residual");
    const name = scriptName(manifest.package.name, strategy.name, ids);
    const sliced = options.appJson === "full" ? { app, report: { ...sliceApp({ app, manifest, entryPoints: [RESIDUAL] }).report, fallbackReason: "linked with appJson: full" } } : sliceApp({ app, manifest, entryPoints: ms });
    const dispatch: "local" | "forward" = sliced.report.mode === "fallback" ? "local" : "forward";
    const capabilities = checkCapabilities({ manifest, app, entryPoints: eps, dispatch, ...(options.allowFindings ? { allowFindings: true } : {}) });
    // A fallback group runs the whole app (any operation, every subscription), so it gets every binding the manifest declares.
    if (sliced.report.mode === "fallback") capabilities.injected = [...new Map([...capabilities.injected, ...declaredAll].map((b) => [`${b.type}\0${b.name}`, b])).values()].sort((a, b) => (`${a.type}\0${a.name}` < `${b.type}\0${b.name}` ? -1 : 1));
    const residual = ms.some((m) => m.kind === "residual");
    const routes = residual ? null : eps.map(routeOf).filter((r): r is HostRoute => !!r);
    const units = [...new Set(residual || ms.some((m) => m.id === "forge:sweep") || options.appJson === "full" ? Object.keys(manifest.units) : eps.flatMap((e) => e.closure))].sort();
    return { name, ids, eps, residual, sliced, dispatch, capabilities, routes, units };
  });
  const sweepGroup = planned.find((g) => g.ids.includes("forge:sweep"));
  const owner = (sweepGroup ?? planned.find((g) => g.residual))!;
  const ownerOf = (pred: (e: ManifestEntryPoint) => boolean) => planned.find((g) => g.eps.some(pred))?.name;

  rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });
  const scripts: LinkedScript[] = [];
  for (const g of planned) {
    const dir = join(options.out, g.name);
    mkdirSync(join(dir, "units"), { recursive: true });
    const crons = g.eps.filter((e) => e.kind === "cron").map((e) => (e.trigger as { cron: string }).cron);
    const queues = g.eps.filter((e) => e.kind === "queue-consumer").map((e) => (e.trigger as { queue: string }).queue);
    const workflows = g.eps.filter((e) => e.kind === "workflow").map((e) => ({ className: (e.trigger as { className: string }).className, workflow: e.id }));
    const realtime = g.eps.find((e) => e.kind === "durable-object");
    const sweepAll = g.ids.includes("forge:sweep");
    const host: HostConfig = {
      script: g.name,
      routes: g.routes,
      deny: g.residual && strategy.name !== "single" ? allRoutes : [],
      bindings: g.capabilities.injected.filter((b) => ENV_BINDINGS.has(b.type)).map((b) => b.name),
      withheld: withheldFrom(declaredAll, g.capabilities.injected),
      dispatch: g.dispatch,
      dispatchOwner: g === owner && strategy.name !== "single",
      sweeps: { outbox: sweepAll, schedules: sweepAll || crons.length > 0, workflows: sweepAll },
    };

    // Unit modules, verified by digest when written.
    const imports: string[] = [];
    const functions: string[] = [];
    const externals: string[] = [];
    const blobs: string[] = [];
    g.units.forEach((h, i) => {
      const u = manifest.units[h]!;
      if (u.kind !== "js-module") return;
      const blob = u.implementation["module"] as string;
      const bytes = modules.get(blob);
      if (!bytes) throw new LinkError("missing-module", `${u.symbol}: module ${blob} is not available`);
      const file = `units/${blob.slice("sha256:".length)}.js`;
      writeFileSync(join(dir, file), bytes);
      blobs.push(blob);
      imports.push(`import u${i} from "./${file}";`);
      if (u.role === "external") externals.push(`${JSON.stringify(u.symbol)}: u${i}`);
      else functions.push(`u${i}`);
    });
    writeFileSync(join(dir, "app.slice.json"), JSON.stringify(g.sliced.app));
    const features = featuresFor(g.sliced.app, g.sliced.report.mode === "slice", host);
    const linked = featureSource(features);
    const lines = [
      `// Generated by ${LINKER} from manifest ${manifest.manifestHash}. Do not edit.`,
      ...(workflows.length || realtime ? [`import { ${[workflows.length ? "WorkflowEntrypoint" : "", realtime ? "DurableObject" : ""].filter(Boolean).join(", ")} } from "cloudflare:workers";`] : []),
      `import { packed } from "@forgegraph/linker-packed/host";`,
      ...linked.imports,
      `import app from "./app.slice.json";`,
      ...imports,
      `const host = packed(app, { functions: [${functions.join(", ")}], externals: { ${externals.join(", ")} }, ${linked.options} }, ${JSON.stringify(host)});`,
      `export default host.worker;`,
      ...workflows.map((w) => `export class ${w.className} extends host.workflow(WorkflowEntrypoint) {}`),
      ...(realtime ? [`export class ${(realtime.trigger as { className: string }).className} extends host.realtime(DurableObject) {}`] : []),
      "",
    ];
    writeFileSync(join(dir, "entry.mjs"), lines.join("\n"));

    const linkerBindings = g.dispatch === "forward" ? [{ type: "service", name: "FORGE_DISPATCH", script: owner.name }] : [];
    const script: LinkedScript = {
      name: g.name,
      members: g.ids,
      entryPoints: g.eps.map((e) => ({ id: e.id, kind: e.kind, closureHash: e.root ? e.closureHash : null })),
      units: g.units,
      modules: blobs.sort(),
      routes: host.routes,
      deny: host.deny,
      crons,
      queues,
      classes: { workflows, realtime: realtime ? (realtime.trigger as { className: string }).className : null },
      dispatch: g.dispatch,
      dispatchOwner: host.dispatchOwner,
      slice: g.sliced.report,
      capabilities: g.capabilities,
      withheld: host.withheld,
      features: { mode: features.mode, names: features.names },
      linkerBindings,
      scriptHash: null,
      bytes: null,
      composition: null,
    };
    writeFileSync(join(dir, "wrangler.jsonc"), `${JSON.stringify(wranglerFor(script, env, { workflow: (className) => ownerOf((e) => e.kind === "workflow" && (e.trigger as { className: string }).className === className), realtime: ownerOf((e) => e.kind === "durable-object") }), null, 2)}\n`);
    if (options.bundle !== false) Object.assign(script, await bundle(dir, options.app, options.minify ?? true));
    scripts.push(script);
  }

  let router: Link["router"] = null;
  if (strategy.name !== "single") {
    const table = scripts.flatMap((s) => (s.routes ?? []).map((r) => ({ ...r, script: s.name })));
    const fallback = scripts.find((s) => s.members.includes(RESIDUAL.id))!.name;
    router = { name: scriptName(manifest.package.name, "router", ["router"]).replace(/-router-[0-9a-f]+$/, "-router"), table: routerOrder(table), fallback, scriptHash: null, bytes: null };
    const dir = join(options.out, router.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "entry.mjs"), routerSource(router.table, router.fallback, manifest.manifestHash));
    writeFileSync(join(dir, "wrangler.jsonc"), `${JSON.stringify({ name: router.name, main: "worker.js", no_bundle: true, compatibility_date: env.compatibility_date, workers_dev: true, services: [...new Set([...router.table.map((r) => r.script), fallback])].map((s) => ({ binding: bindingOf(s), service: s })) }, null, 2)}\n`);
    if (options.bundle !== false) {
      const b = await bundle(dir, options.app, options.minify ?? true);
      router.scriptHash = b.scriptHash;
      router.bytes = b.bytes;
    }
  }

  const result: Link = {
    version: "packed-link/1",
    linker: LINKER,
    manifestHash: manifest.manifestHash,
    package: manifest.package,
    strategy: strategy.name,
    compatibilityDate: env.compatibility_date,
    scripts,
    router,
    live: manifest.manifestHash,
  };
  writeFileSync(join(options.out, "link.json"), stableJson(result));
  return result;
}

export const bindingOf = (script: string) => `S_${script.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;

/** Literal segments beat parameters, so `/customers/queries/by-code` wins over `/customers/{id}`. */
function routerOrder<T extends HostRoute>(table: T[]): T[] {
  const params = (p: string) => p.split("/").filter((s) => s.startsWith("{")).length;
  return [...table].sort((a, b) => params(a.path) - params(b.path) || b.path.length - a.path.length || (a.path + a.method < b.path + b.method ? -1 : 1));
}

function routerSource(table: Array<HostRoute & { script: string }>, fallback: string, manifestHash: string): string {
  const rows = table.map((r) => [r.method, `^${r.path.split("/").map((s) => (/^\{.+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`, bindingOf(r.script)]);
  return [
    `// Generated router for manifest ${manifestHash}: (method, path) -> script, by service binding. No runtime, no app code.`,
    `const table = ${JSON.stringify(rows)}.map(([m, re, s]) => [m, new RegExp(re), s]);`,
    `export default {`,
    `  async fetch(request, env) {`,
    `    const path = new URL(request.url).pathname;`,
    `    const hit = table.find(([m, re]) => m === request.method && re.test(path));`,
    `    const target = env[hit ? hit[2] : ${JSON.stringify(bindingOf(fallback))}];`,
    `    // Buffer the body: a callee that answers before reading it (413, 401) would otherwise leave the`,
    `    // client's connection half-read across the hop, and the client's next request on it fails.`,
    `    if (!request.body) return target.fetch(request);`,
    `    return target.fetch(new Request(request, { body: await request.arrayBuffer() }));`,
    `  },`,
    `};`,
    "",
  ].join("\n");
}

async function bundle(dir: string, appRoot: string, minify: boolean): Promise<{ scriptHash: string; bytes: { raw: number; gzip: number }; composition: Record<string, number> }> {
  const result = await build({
    entryPoints: [join(dir, "entry.mjs")],
    absWorkingDir: resolve(appRoot),
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["source", "workerd", "worker", "browser", "import"],
    external: ["cloudflare:*", "node:*"],
    nodePaths: [join(resolve(appRoot), "node_modules")],
    alias: { "@forgegraph/linker-packed/host": HOST },
    minify,
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.contents;
  writeFileSync(join(dir, "worker.js"), code);
  const inputs = Object.values(result.metafile.outputs)[0]!.inputs;
  const composition: Record<string, number> = {};
  for (const [file, v] of Object.entries(inputs)) {
    const origin = /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?effect\//.test(file)
      ? "effect"
      : /packages\/runtime\//.test(file)
        ? "runtime"
        : /packages\/linker-packed\//.test(file)
          ? "host"
          : /app\.slice\.json$/.test(file)
            ? "app.json"
            : /units\/[0-9a-f]{64}\.js$/.test(file)
              ? "units"
              : /entry\.mjs$/.test(file)
                ? "entry"
                : "other";
    composition[origin] = (composition[origin] ?? 0) + v.bytesInOutput;
  }
  return { scriptHash: sha256(code), bytes: { raw: code.byteLength, gzip: gzipSync(code, { level: 9 }).byteLength }, composition };
}

/** The script's wrangler config: the app's environment, projected onto the bindings the script is given. */
function wranglerFor(s: LinkedScript, env: Environment, owners: { workflow: (className: string) => string | undefined; realtime: string | undefined }): Record<string, unknown> {
  const names = new Set(s.capabilities.injected.map((b) => b.name));
  const out: Record<string, unknown> = { name: s.name, main: "worker.js", no_bundle: true, compatibility_date: env.compatibility_date, workers_dev: false };
  const vars = Object.fromEntries(Object.entries(env.vars ?? {}).filter(([k]) => names.has(k)));
  if (Object.keys(vars).length) out["vars"] = vars;
  const d1 = (env.d1_databases ?? []).filter((d) => names.has(d.binding));
  if (d1.length) out["d1_databases"] = d1;
  const r2 = (env.r2_buckets ?? []).filter((d) => names.has(d.binding));
  if (r2.length) out["r2_buckets"] = r2;
  const dos = (env.durable_objects?.bindings ?? []).filter((d) => names.has(d.name)).map((d) => (s.classes.realtime === d.class_name ? d : { ...d, script_name: owners.realtime }));
  if (dos.length) out["durable_objects"] = { bindings: dos };
  if (s.classes.realtime) out["migrations"] = (env.migrations ?? []).filter((m) => (m.new_sqlite_classes ?? []).includes(s.classes.realtime!));
  const wfs = (env.workflows ?? [])
    .filter((w) => names.has(w.binding) || s.classes.workflows.some((c) => c.className === w.class_name))
    .map((w) => (s.classes.workflows.some((c) => c.className === w.class_name) ? w : { ...w, script_name: owners.workflow(w.class_name) }));
  if (wfs.length) out["workflows"] = wfs;
  const producers = (env.queues?.producers ?? []).filter((q) => names.has(q.binding));
  const consumers = (env.queues?.consumers ?? []).filter((q) => s.queues.includes(q.queue));
  if (producers.length || consumers.length) out["queues"] = { ...(producers.length ? { producers } : {}), ...(consumers.length ? { consumers } : {}) };
  if (s.crons.length) out["triggers"] = { crons: s.crons };
  if (s.linkerBindings.length) out["services"] = s.linkerBindings.map((b) => ({ binding: b.name, service: b.script }));
  const secrets = s.capabilities.injected.filter((b) => b.type === "secret").map((b) => b.name);
  if (secrets.length) out["//secrets"] = secrets;
  return out;
}
