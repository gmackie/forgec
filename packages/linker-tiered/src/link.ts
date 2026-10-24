// Linker C (tiered). Sealed Closure Manifest + a dynamic policy in, a deployment out:
//   packed/            linker A's per-entry-point output for *every* entry point, dynamic ones included:
//                      a dynamic entry point's packed script is its fallback. Linked with `advance`,
//                      so the script holding a workflow class can run one driver step for the tier host.
//   <router>/          the tiered router (replaces A's router): (method, path) -> packed script, or the
//                      dynamic host first for a dynamic entry point, falling back on B's refusal.
//   <host>/            the dynamic tier: linker B's host plus the Workflows classes of dynamic workflows.
//   tiered.json        the deployment: what is packed, what is dynamic, which scripts to upload.
// A's router script is linked (A always emits one) but not deployed: tiered.json lists the scripts.
//
// Updating a dynamic closure is a PUT of module blobs and a manifest to the tier host's unit store
// (B's /_linker/*); no script in this output changes. Moving an entry point between tiers, or a new
// binding for a dynamic closure, is a re-link.
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { bindingOf, link, loadManifest, readJsonc, type Environment, type Link, type LinkedScript, type Manifest } from "@forgegraph/linker-packed";
import { ADVANCE_PATH, DISPATCH_PATH } from "@forgegraph/linker-packed/host";
import { COMPATIBILITY_DATE } from "@forgegraph/linker-dynamic";
import { sha256, stableJson } from "@forgegraph/units";
import { resolvePolicy, TieredLinkError, type DynamicPolicy, type ResolvedDynamic } from "./policy.ts";
import type { TierConfig } from "./host.ts";
import pkg from "../package.json" with { type: "json" };

export const LINKER = `${pkg.name}@${pkg.version}`;
const TIER_HOST = resolve(import.meta.dirname, "host.ts");
const DYNAMIC_HOST = resolve(import.meta.dirname, "../../linker-dynamic/src/host.ts");
const DYNAMIC_INDEX = resolve(import.meta.dirname, "../../linker-dynamic/src/index.ts");
/** B's refusal header (linker-dynamic REFUSED_HEADER): the router falls back on it and only on it. */
export const REFUSED_HEADER = "x-forge-linker-refused";
export const DYNAMIC_BINDING = "FORGE_DYNAMIC";
export const STATS_PATH = "/_forge/tiered/stats";

export interface TieredLinkOptions {
  manifestDir: string;
  app: string;
  out: string;
  environment: string;
  policy: DynamicPolicy;
  manifest?: Manifest;
  minify?: boolean;
  bundle?: boolean;
}

export interface ScriptRef {
  name: string;
  scriptHash: string | null;
  bytes: { raw: number; gzip: number } | null;
}

export interface TieredLink {
  version: "tiered-link/1";
  linker: string;
  manifestHash: string;
  package: { name: string; version: string };
  policy: DynamicPolicy;
  /** Dynamic entry points with the packed script each falls back to. */
  dynamic: Array<ResolvedDynamic & { packedScript: string }>;
  packed: { dir: "packed"; strategy: string; scripts: ScriptRef[]; dispatchOwner: string };
  router: ScriptRef & { table: Array<{ method: string; path: string; script: string; dynamic: string | null }>; fallback: string };
  host: ScriptRef & { compatibilityDate: string; bindings: string[]; services: Record<string, string>; workflows: TierConfig["workflows"] };
  /** Every script a deploy uploads (A's own router is not one of them). */
  deploy: string[];
}

/** Env bindings (handles, vars, secrets) the tier host passes to B's children. */
const HOST_BINDING_TYPES = new Set(["d1", "r2", "queue-producer", "workflow", "secret", "var"]);

export async function linkTiered(options: TieredLinkOptions): Promise<TieredLink> {
  const packedOut = join(options.out, "packed");
  rmSync(options.out, { recursive: true, force: true });
  const { manifest } = loadManifest(options.manifestDir, options.manifest);
  const resolved = resolvePolicy(manifest, options.policy);
  const packed: Link = await link({ app: options.app, manifestDir: options.manifestDir, environment: options.environment, strategy: "per-entry-point", out: packedOut, advance: true, ...(options.manifest ? { manifest: options.manifest } : {}), ...(options.minify === undefined ? {} : { minify: options.minify }), ...(options.bundle === undefined ? {} : { bundle: options.bundle }) });
  if (!packed.router) throw new TieredLinkError("tier", "linker A produced no router");
  const env = readJsonc(options.environment) as Environment;
  const scriptOf = (id: string): LinkedScript => {
    const s = packed.scripts.find((x) => x.members.includes(id));
    if (!s) throw new TieredLinkError("tier", `no packed script holds ${id}`);
    return s;
  };
  const owner = packed.scripts.find((s) => s.dispatchOwner);
  if (!owner) throw new TieredLinkError("tier", "linker A linked no dispatch owner");
  const dynamic = resolved.entryPoints.map((d) => ({ ...d, packedScript: scriptOf(d.id).name }));
  const dynamicIds = new Set(dynamic.map((d) => d.id));

  // Router: A's table and order, each row tagged with its entry point when that entry point is dynamic.
  const routeId = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
  const table = packed.router.table.map((r) => ({ method: r.method, path: r.path, script: r.script, dynamic: dynamicIds.has(routeId(r)) ? routeId(r) : null }));
  const base = manifest.package.name.replace(/^@/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const routerName = `${base}-tiered`.slice(0, 63);
  const hostName = `${base}-dynamic`.slice(0, 63);

  // The tier host's bindings: what the dynamic entry points declare, plus the manifest's host vars and secrets.
  const entries = manifest.entryPoints.filter((e) => dynamicIds.has(e.id));
  const declared = [...manifest.hostBindings, ...entries.flatMap((e) => e.bindings)].filter((b) => HOST_BINDING_TYPES.has(b.type));
  const bindings = [...new Set(declared.map((b) => b.name))].sort();
  const workflows = entries
    .filter((e) => e.kind === "workflow")
    .map((e) => {
      const className = (e.trigger as { className: string }).className;
      const s = scriptOf(e.id);
      return { className, entryPoint: e.id, packed: `FORGE_PACKED_${className.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`, packedScript: s.name };
    });
  const services: Record<string, string> = { FORGE_DISPATCH: owner.name, ...Object.fromEntries(workflows.map((w) => [w.packed, w.packedScript])) };
  const tierConfig: TierConfig = { script: hostName, manifestHash: manifest.manifestHash, dynamic: [...dynamicIds].sort(), bindings, workflows, advancePath: ADVANCE_PATH };

  // Emit the router and the tier host.
  const routerDir = join(options.out, routerName);
  mkdirSync(routerDir, { recursive: true });
  const targets = [...new Set([...table.map((r) => r.script), packed.router.fallback])].sort();
  writeFileSync(join(routerDir, "entry.mjs"), routerSource(table, packed.router.fallback, manifest.manifestHash));
  writeFileSync(join(routerDir, "wrangler.jsonc"), `${JSON.stringify({ name: routerName, main: "worker.js", no_bundle: true, compatibility_date: env.compatibility_date, workers_dev: true, services: [...targets.map((s) => ({ binding: bindingOf(s), service: s })), { binding: DYNAMIC_BINDING, service: hostName }], "//secrets": ["TIER_STATS_TOKEN"] }, null, 2)}\n`);

  const hostDir = join(options.out, hostName);
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, "entry.mjs"), hostSource(tierConfig));
  writeFileSync(join(hostDir, "wrangler.jsonc"), `${JSON.stringify(hostWrangler(hostName, env, bindings, services, workflows), null, 2)}\n`);

  // A dynamic workflow's class lives in the tier host. The packed script that held it keeps the class
  // (unused, so its bytes do not change), and every packed config naming the workflow binds the tier
  // host's class instead: C writes those scripts' deploy config next to A's (wrangler.tiered.jsonc).
  const moved = new Set(workflows.map((w) => w.className));
  for (const s of packed.scripts) {
    const cfg = readJsonc(join(packedOut, s.name, "wrangler.jsonc")) as Record<string, unknown> & { workflows?: Array<Record<string, unknown>> };
    if (!cfg.workflows?.some((x) => moved.has(String(x["class_name"])))) continue;
    cfg.workflows = cfg.workflows.map((x) => (moved.has(String(x["class_name"])) ? { ...x, script_name: hostName } : x));
    writeFileSync(join(packedOut, s.name, "wrangler.tiered.jsonc"), `${JSON.stringify(cfg, null, 2)}\n`);
  }

  const doBundle = options.bundle !== false;
  const minify = options.minify ?? true;
  const routerBundle = doBundle ? await bundle(routerDir, options.app, minify) : null;
  const hostBundle = doBundle ? await bundle(hostDir, options.app, minify) : null;
  const ref = (name: string, b: { scriptHash: string; bytes: { raw: number; gzip: number } } | null): ScriptRef => ({ name, scriptHash: b?.scriptHash ?? null, bytes: b?.bytes ?? null });

  const result: TieredLink = {
    version: "tiered-link/1",
    linker: LINKER,
    manifestHash: manifest.manifestHash,
    package: manifest.package,
    policy: options.policy,
    dynamic,
    packed: { dir: "packed", strategy: packed.strategy, scripts: packed.scripts.map((s) => ({ name: s.name, scriptHash: s.scriptHash, bytes: s.bytes })), dispatchOwner: owner.name },
    router: { ...ref(routerName, routerBundle), table, fallback: packed.router.fallback },
    host: { ...ref(hostName, hostBundle), compatibilityDate: COMPATIBILITY_DATE, bindings, services, workflows },
    deploy: [routerName, hostName, ...packed.scripts.map((s) => s.name)],
  };
  writeFileSync(join(options.out, "tiered.json"), stableJson(result));
  return result;
}

function routerSource(table: TieredLink["router"]["table"], fallback: string, manifestHash: string): string {
  const rows = table.map((r) => [r.method, `^${r.path.split("/").map((s) => (/^\{.+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`, bindingOf(r.script), r.dynamic]);
  return `// Generated by ${LINKER}: the tiered router for manifest ${manifestHash}. No runtime, no app code.
// (method, path) -> the packed script, by service binding; a dynamic entry point goes to the dynamic
// host first and falls back to its packed script when the host refuses it before any unit code ran
// (the ${REFUSED_HEADER} header). Every answer says which tier served it (x-forge-tier).
const table = ${JSON.stringify(rows)}.map(([m, re, s, d]) => [m, new RegExp(re), s, d]);
const stats = { since: new Date().toISOString(), dynamic: 0, packed: 0, fallback: 0, errors: 0, byReason: {}, byEntryPoint: {}, recent: [] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function tagged(res, tier, miss) {
  if (res.status === 101 || res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-forge-tier", tier);
  if (miss) out.headers.set("x-forge-tier-miss", miss);
  return out;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === ${JSON.stringify(STATS_PATH)}) {
      if (!env.TIER_STATS_TOKEN || request.headers.get("x-forge-tier-token") !== env.TIER_STATS_TOKEN) return json({ code: "NotFound" }, 404);
      if (request.method === "DELETE") { Object.assign(stats, { since: new Date().toISOString(), dynamic: 0, packed: 0, fallback: 0, errors: 0, byReason: {}, byEntryPoint: {}, recent: [] }); return json({ ok: true }); }
      return json(stats);
    }
    // An exact (method, path) entry; else the packed script owning the path, whose runtime answers 405
    // or a CORS preflight; else the residual, which authenticates and answers 404. Only an exact match
    // on a dynamic entry point is served dynamically.
    const exact = table.find(([m, re]) => m === request.method && re.test(path));
    const hit = exact ?? table.find(([, re]) => re.test(path));
    const packed = env[hit ? hit[2] : ${JSON.stringify(bindingOf(fallback))}];
    // Buffer the body once: the fallback replays it, and a callee that answers before reading it would
    // otherwise leave the client's connection half-read across the hop.
    const body = request.body ? await request.arrayBuffer() : null;
    const again = () => (body === null ? new Request(request) : new Request(request, { body }));
    const entry = exact && exact[3];
    if (!entry || request.headers.get("upgrade")) {
      stats.packed++;
      return tagged(await packed.fetch(again()), "packed");
    }
    let reason = null;
    let res = null;
    if (!env.${DYNAMIC_BINDING}) reason = "NoDynamicHost";
    else {
      try {
        res = await env.${DYNAMIC_BINDING}.fetch(again());
        reason = res.headers.get(${JSON.stringify(REFUSED_HEADER)});
      } catch (e) {
        // Not a refusal: the host may have run unit code before it failed, so replaying is unsafe.
        stats.errors++;
        console.error("linker-tiered: dynamic tier failed", request.method, path, String(e));
        return json({ type: "https://forge.dev/errors/linker/DynamicTierFailed", title: "DynamicTierFailed", status: 502, code: "DynamicTierFailed", detail: String(e).slice(0, 300), retryable: true }, 502);
      }
    }
    if (!reason) {
      stats.dynamic++;
      return tagged(res, "dynamic");
    }
    if (res) await res.body?.cancel();
    stats.fallback++;
    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    stats.byEntryPoint[entry] = (stats.byEntryPoint[entry] ?? 0) + 1;
    stats.recent.push({ at: new Date().toISOString(), entry, reason });
    if (stats.recent.length > 50) stats.recent.shift();
    console.warn("linker-tiered: FALLBACK " + entry + " -> packed (" + reason + ")");
    return tagged(await packed.fetch(again()), "packed-fallback", reason);
  },
};
`;
}

function hostSource(config: TierConfig): string {
  return [
    `// Generated by ${LINKER} from manifest ${config.manifestHash}: the dynamic tier. Do not edit.`,
    ...(config.workflows.length ? [`import { WorkflowEntrypoint } from "cloudflare:workers";`] : []),
    `import { tier } from "@forgegraph/linker-tiered/host";`,
    `export { D1Gate, Egress, ObjectsGate, QueueGate, WorkflowGate } from "@forgegraph/linker-dynamic/host";`,
    `const host = tier(${JSON.stringify(config)});`,
    `export default host.worker;`,
    ...config.workflows.map((w) => `export class ${w.className} extends host.workflow(WorkflowEntrypoint, ${JSON.stringify(w.className)}) {}`),
    "",
  ].join("\n");
}

function hostWrangler(name: string, env: Environment, bindings: string[], services: Record<string, string>, workflows: TierConfig["workflows"]): Record<string, unknown> {
  const has = (n: string) => bindings.includes(n);
  const out: Record<string, unknown> = { name, main: "worker.js", no_bundle: true, compatibility_date: COMPATIBILITY_DATE, workers_dev: false, worker_loaders: [{ binding: "LOADER" }] };
  const vars = Object.fromEntries(Object.entries(env.vars ?? {}).filter(([k]) => has(k)));
  if (Object.keys(vars).length) out["vars"] = vars;
  out["r2_buckets"] = [{ binding: "UNITS", bucket_name: "forge-units" }, ...(env.r2_buckets ?? []).filter((b) => has(b.binding))];
  const d1 = (env.d1_databases ?? []).filter((d) => has(d.binding));
  if (d1.length) out["d1_databases"] = d1;
  const wfs = (env.workflows ?? []).filter((w) => has(w.binding) || workflows.some((c) => c.className === w.class_name));
  if (wfs.length) out["workflows"] = wfs;
  const producers = (env.queues?.producers ?? []).filter((q) => has(q.binding));
  if (producers.length) out["queues"] = { producers };
  out["services"] = Object.entries(services).map(([binding, service]) => ({ binding, service }));
  out["//secrets"] = [...bindings.filter((b) => b === "CURSOR_SECRET"), "LINKER_ADMIN_TOKEN"];
  out["//dispatch"] = `post-commit dispatch is handed to ${services["FORGE_DISPATCH"]} (${DISPATCH_PATH}); this script runs no sweep and no cron`;
  return out;
}

async function bundle(dir: string, appRoot: string, minify: boolean): Promise<{ scriptHash: string; bytes: { raw: number; gzip: number } }> {
  const result = await build({
    entryPoints: [join(dir, "entry.mjs")],
    absWorkingDir: resolve(appRoot),
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["source", "workerd", "worker", "browser", "import"],
    external: ["cloudflare:*", "node:*"],
    nodePaths: [join(resolve(appRoot), "node_modules")],
    alias: { "@forgegraph/linker-tiered/host": TIER_HOST, "@forgegraph/linker-dynamic/host": DYNAMIC_HOST, "@forgegraph/linker-dynamic": DYNAMIC_INDEX },
    minify,
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.contents;
  writeFileSync(join(dir, "worker.js"), code);
  return { scriptHash: sha256(code), bytes: { raw: code.byteLength, gzip: gzipSync(code, { level: 9 }).byteLength } };
}
