// Runs a tiered link locally in workerd through Miniflare (linker A's `serve`): every packed script,
// the tiered router (the entry) and the tier host with a Worker Loader and a local R2 unit store, all
// sharing one D1 database, queues and Workflows. Also serves linker B's own host (examples/acme's
// `host/acme.ts`) the same way, for the differential. The dynamic tier is seeded through B's
// `/_linker/*` administration, reached with `mf.getWorker(host)` rather than through the router.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bindingOf, type Environment, type Link } from "@forgegraph/linker-packed";
import { scriptsOf, serve, type LocalScript, type Served } from "@forgegraph/linker-packed/local";
import { COMPATIBILITY_DATE } from "@forgegraph/linker-dynamic";
import { DYNAMIC_BINDING, type TieredLink } from "./link.ts";

export const ADMIN_TOKEN = "local-linker-admin";
export const STATS_TOKEN = "local-tier-stats";
const root = resolve(import.meta.dirname, "../../..");
const dynamicPkg = join(root, "packages/linker-dynamic");

export interface TierOptions {
  /** Bind the Worker Loader (default true). false: the loader is unavailable, every dynamic request is a miss. */
  loader?: boolean;
}

/** Miniflare scripts for a tiered link in `dir`: router first, then the tier host, then every packed script. */
export function tieredScriptsOf(t: TieredLink, dir: string, o: TierOptions = {}): LocalScript[] {
  const packedLink = JSON.parse(readFileSync(join(dir, t.packed.dir, "link.json"), "utf8")) as Link;
  const moved = new Set(t.host.workflows.map((w) => w.className));
  const packed = scriptsOf({ ...packedLink, router: null }, join(dir, t.packed.dir)).map((s) => ({ ...s, classes: { ...s.classes, workflows: s.classes.workflows.filter((c) => !moved.has(c.className)) } }));
  const targets = [...new Set([...t.router.table.map((r) => r.script), t.router.fallback])];
  const router: LocalScript = {
    name: t.router.name,
    scriptPath: join(dir, t.router.name, "worker.js"),
    bindings: [],
    queues: [],
    classes: { workflows: [], realtime: null },
    services: { ...Object.fromEntries(targets.map((s) => [bindingOf(s), s])), [DYNAMIC_BINDING]: t.host.name },
    miniflare: { bindings: { TIER_STATS_TOKEN: STATS_TOKEN } },
  };
  const host: LocalScript = {
    name: t.host.name,
    scriptPath: join(dir, t.host.name, "worker.js"),
    bindings: t.host.bindings,
    queues: [],
    classes: { workflows: t.host.workflows.map((w) => ({ className: w.className })), realtime: null },
    services: t.host.services,
    miniflare: dynamicMiniflare(t.host.bindings, o),
  };
  return [router, host, ...packed];
}

function dynamicMiniflare(bindings: string[], o: TierOptions): Record<string, unknown> {
  return {
    compatibilityDate: COMPATIBILITY_DATE,
    r2Buckets: { UNITS: "forge-units", ...(bindings.includes("BLOBS") ? { BLOBS: "forge-acme-blobs" } : {}) },
    ...(o.loader === false ? {} : { workerLoaders: { LOADER: {} } }),
    bindings: { LINKER_ADMIN_TOKEN: ADMIN_TOKEN },
  };
}

/** Linker B's host for examples/acme (packages/linker-dynamic/host/acme.ts), bundled into `out` for Miniflare. */
export async function dynamicHostScript(out: string, env: Environment): Promise<LocalScript> {
  mkdirSync(out, { recursive: true });
  const r = await build({
    entryPoints: [join(dynamicPkg, "host/acme.ts")],
    absWorkingDir: dynamicPkg,
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["source", "workerd", "worker", "browser", "import"],
    external: ["cloudflare:*", "node:*"],
    minify: true,
    logLevel: "silent",
  });
  writeFileSync(join(out, "worker.js"), r.outputFiles[0]!.contents);
  const bindings = ["DB", "BLOBS", "Q_FULFILL_ORDER", "WF_PROCESS_ORDER", "CURSOR_SECRET", "FORGE_AUTH", "FORGE_CORS"];
  return {
    name: "forge-acme-linker-dynamic",
    scriptPath: join(out, "worker.js"),
    bindings,
    queues: (env.queues?.consumers ?? []).map((q) => q.queue),
    classes: { workflows: (env.workflows ?? []).map((w) => ({ className: w.class_name })), realtime: null },
    services: {},
    miniflare: dynamicMiniflare(bindings, {}),
  };
}

export type { Served };
export { serve };

// ------------------------------------------------------------------------- dynamic tier admin
interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export async function hostFetcher(served: Served, host: string): Promise<FetcherLike> {
  const w = (await served.mf.getWorker(host)) as unknown as FetcherLike;
  return { fetch: (path, init = {}) => w.fetch(`http://tier.local${path}`, { ...init, headers: { "x-linker-admin": ADMIN_TOKEN, ...((init.headers as Record<string, string>) ?? {}) } }) };
}

async function ok<T>(r: Response, what: string): Promise<T> {
  const text = await r.text();
  if (!r.ok) throw new Error(`${what}: ${r.status} ${text}`);
  return JSON.parse(text) as T;
}

export interface Uploads {
  /** Blob digests uploaded, by what they are. */
  blobs: Array<{ digest: string; what: string; bytes: number }>;
}

/** Uploads linker B's libraries (packages/linker-dynamic/generated/libs) and the app bundle, and writes the kit. */
export async function seedKit(host: FetcherLike, appJson: string): Promise<Uploads> {
  const libsDir = join(dynamicPkg, "generated/libs");
  if (!existsSync(join(libsDir, "libs.json"))) throw new Error(`no ${libsDir}/libs.json: run pnpm --filter @forgegraph/linker-dynamic build`);
  const libs = JSON.parse(readFileSync(join(libsDir, "libs.json"), "utf8")) as Record<string, { file: string }>;
  const uploads: Uploads = { blobs: [] };
  const put = async (bytes: Uint8Array<ArrayBuffer>, what: string) => {
    const { digest } = await ok<{ digest: string }>(await host.fetch("/_linker/blobs", { method: "PUT", body: bytes }), `upload ${what}`);
    uploads.blobs.push({ digest, what, bytes: bytes.byteLength });
    return digest;
  };
  const libraries: Record<string, string> = {};
  for (const [name, l] of Object.entries(libs)) libraries[name] = await put(new Uint8Array(readFileSync(join(libsDir, l.file))), `library ${name}`);
  const appBytes = new Uint8Array(readFileSync(appJson));
  const app = JSON.parse(new TextDecoder().decode(appBytes)) as { buildHash: string };
  const apps = { [app.buildHash]: await put(appBytes, "app.json") };
  await ok(await host.fetch("/_linker/kit", { method: "PUT", body: JSON.stringify({ libraries, apps }) }), "kit");
  return uploads;
}

/**
 * Makes `manifestText` the dynamic tier's manifest: uploads the module blobs the store does not have
 * yet (`known`: digests already uploaded) and PUTs the manifest. Returns the link answer and what was uploaded.
 */
export async function linkDynamic(host: FetcherLike, o: { manifestText: string; modulesDir: string; known?: Set<string>; skip?: string[] }): Promise<{ status: number; body: Record<string, unknown>; uploaded: Uploads["blobs"]; ms: number }> {
  const uploaded: Uploads["blobs"] = [];
  const t0 = performance.now();
  const manifest = JSON.parse(o.manifestText) as { modules: Record<string, unknown> };
  for (const f of readdirSync(o.modulesDir)) {
    const digest = `sha256:${f.replace(/\.js$/, "")}`;
    if (!manifest.modules[digest] || o.known?.has(digest) || o.skip?.includes(digest)) continue;
    const bytes = new Uint8Array(readFileSync(join(o.modulesDir, f)));
    await ok(await host.fetch("/_linker/blobs", { method: "PUT", body: bytes }), `module ${digest}`);
    uploaded.push({ digest, what: "module", bytes: bytes.byteLength });
    o.known?.add(digest);
  }
  const r = await host.fetch("/_linker/manifest", { method: "PUT", body: o.manifestText });
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, body, uploaded, ms: performance.now() - t0 };
}

export async function tierStats(served: Served): Promise<{ dynamic: number; packed: number; fallback: number; errors: number; byReason: Record<string, number>; byEntryPoint: Record<string, number>; recent: Array<{ entry: string; reason: string }> }> {
  return ok(await fetch(`${served.url}/_forge/tiered/stats`, { headers: { "x-forge-tier-token": STATS_TOKEN } }), "router stats");
}
export async function resetTierStats(served: Served): Promise<void> {
  await fetch(`${served.url}/_forge/tiered/stats`, { method: "DELETE", headers: { "x-forge-tier-token": STATS_TOKEN } });
}
