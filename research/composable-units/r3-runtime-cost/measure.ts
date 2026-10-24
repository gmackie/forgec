// FORG-42 measurements: what linker A's per-script runtime costs, and what each way of not paying it
// per script saves. Run from the repository root after building (see run.sh):
//   node research/composable-units/r3-runtime-cost/measure.ts
// Writes results/measure.json:
//   - sizes: per-script raw/gzip (min, median, max), total deploy bytes, per strategy;
//   - bodyEdit: what a one-body edit (impl/rebuild-order-summary.ts, as FORG-29/37) re-uploads;
//   - effect: what Effect a CRUD script pulls in (esbuild metafile) against Effect's floor (approach 2);
//   - crossings: RPC calls per request between a shared script and the runtime Worker (in Node);
//   - latency: cold and warm read and write in local workerd (Miniflare), per-entry-point vs shared.
// Same bundling as FORG-29/37: esbuild, minified, ESM, platform neutral, cloudflare:* and node:* external, gzip -9.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seal, writeSealed, type UnitPlan } from "../../../packages/units/src/index.ts";
import { link, perEntryPoint, readJsonc, type Environment, type GroupingStrategy, type Link, type Member } from "../../../packages/linker-packed/src/index.ts";
import { scriptsOf, serve, type LocalScript } from "../../../packages/linker-packed/src/local.ts";
import { sharedRuntime } from "../../../packages/linker-packed/src/shared/runtime.ts";
import { packedShared } from "../../../packages/linker-packed/src/shared/script.ts";
import { unitHost } from "../../../packages/linker-packed/src/shared/units.ts";
import type { HostConfig } from "../../../packages/linker-packed/src/host.ts";
import type { SharedMeta } from "../../../packages/linker-packed/src/shared/protocol.ts";

const root = resolve(import.meta.dirname, "../../..");
const here = import.meta.dirname;
const forgec = join(root, "target/debug/forgec");
const { build } = createRequire(join(root, "packages/linker-packed/package.json"))("esbuild") as typeof import("esbuild");
const scratch: string[] = [];
const COLD_RUNS = Number(process.env["COLD_RUNS"] ?? 5);
const WARM_RUNS = Number(process.env["WARM_RUNS"] ?? 30);

/** Approach 3 (sized only, not run through the differential): one script per resource path, so fewer copies of the runtime. */
const resourceKey = (m: Member) => (m.kind === "http-route" ? `route:${(m.trigger as { path: string }).path.split("/").slice(0, 3).join("/")}` : m.id);
const perResource: GroupingStrategy = {
  name: "per-resource",
  description: "FORG-42 research: http routes grouped by their first two path segments (one script per resource), every other entry point alone.",
  group: (members) => [...Map.groupBy(members, resourceKey).values()].map((g) => g.map((m) => m.id)),
};
const perResourceShared: GroupingStrategy = { ...perResource, name: "per-resource-shared", runtime: "shared" };
const STRATEGIES: Array<string | GroupingStrategy> = ["single", "per-entry-point", "per-entry-point-shared", perResource, perResourceShared];
const nameOf = (s: string | GroupingStrategy) => (typeof s === "string" ? s : s.name);

function copyAcme(edit?: (app: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-r3-"));
  scratch.push(dir);
  const app = join(dir, "acme");
  for (const part of ["src", "impl", "deploy", "migrations", "forge.toml", "forge.lock", "package.json", "tsconfig.json"]) cpSync(join(root, "examples/acme", part), join(app, part), { recursive: true });
  cpSync(join(root, "examples/payments"), join(dir, "payments"), { recursive: true });
  const toml = join(app, "forge.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replaceAll('"../../packages/', `"${root}/packages/`));
  symlinkSync(join(root, "examples/acme/node_modules"), join(app, "node_modules"), "dir");
  edit?.(app);
  return app;
}

async function buildAndLink(app: string) {
  execFileSync(forgec, ["build", app, "--units"], { stdio: "pipe" });
  const units = join(app, "generated/units");
  const sealed = await seal(JSON.parse(readFileSync(join(units, "plan.json"), "utf8")) as UnitPlan, app);
  writeSealed(sealed, units);
  const links: Record<string, Link> = {};
  for (const strategy of STRATEGIES) links[nameOf(strategy)] = await link({ app, manifestDir: units, environment: join(app, "deploy/cloudflare/wrangler.jsonc"), strategy, out: join(app, "generated/linked", nameOf(strategy)) });
  return { app, manifest: sealed.manifest, links };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { count: s.length, min: s[0] ?? 0, median: s[Math.floor(s.length / 2)] ?? 0, max: s.at(-1) ?? 0 };
};
const median = (xs: number[]) => stats(xs).median;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] ?? 0;

/** Every uploaded script: the group scripts, the router and (shared) the runtime Worker. */
const uploads = (l: Link) => [
  ...l.scripts.map((s) => ({ name: s.name, scriptHash: s.scriptHash, raw: s.bytes!.raw, gzip: s.bytes!.gzip })),
  ...(l.router ? [{ name: l.router.name, scriptHash: l.router.scriptHash, raw: l.router.bytes!.raw, gzip: l.router.bytes!.gzip }] : []),
  ...(l.runtime ? [{ name: l.runtime.name, scriptHash: l.runtime.scriptHash, raw: l.runtime.bytes!.raw, gzip: l.runtime.bytes!.gzip }] : []),
];

function summarize(l: Link) {
  const all = uploads(l);
  const inProcess = l.scripts.filter((s) => s.runtime?.mode === "in-process");
  const engine = (s: Link["scripts"][number]) => (s.composition?.["runtime"] ?? 0) + (s.composition?.["effect"] ?? 0);
  return {
    scripts: l.scripts.length,
    uploads: all.length,
    router: l.router ? { raw: l.router.bytes!.raw, gzip: l.router.bytes!.gzip } : null,
    runtimeWorker: l.runtime ? { raw: l.runtime.bytes!.raw, gzip: l.runtime.bytes!.gzip, composition: l.runtime.composition } : null,
    raw: stats(l.scripts.map((s) => s.bytes!.raw)),
    gzip: stats(l.scripts.map((s) => s.bytes!.gzip)),
    runtimePlusEffect: stats(l.scripts.map(engine)),
    scriptsCarryingEngine: l.scripts.filter((s) => (s.composition?.["runtime"] ?? 0) > 20_000).length,
    scriptsCarryingEffect: l.scripts.filter((s) => (s.composition?.["effect"] ?? 0) > 0).length,
    inProcess: inProcess.map((s) => ({ name: s.name, reason: s.runtime!.reason, raw: s.bytes!.raw })),
    deployRaw: all.reduce((n, s) => n + s.raw, 0),
    deployGzip: all.reduce((n, s) => n + s.gzip, 0),
    perScript: l.scripts.map((s) => ({ name: s.name, members: s.members.length > 3 ? `${s.members.length} members` : s.members, raw: s.bytes!.raw, gzip: s.bytes!.gzip, runtime: s.runtime?.mode ?? "in-process", composition: s.composition })),
  };
}

function bodyEditDiff(base: Awaited<ReturnType<typeof buildAndLink>>, edited: Awaited<ReturnType<typeof buildAndLink>>) {
  return Object.fromEntries(
    STRATEGIES.map(nameOf).map((strategy) => {
      const before = new Map(uploads(base.links[strategy]!).map((s) => [s.name, s.scriptHash]));
      const after = uploads(edited.links[strategy]!);
      const changed = after.filter((s) => before.get(s.name) !== s.scriptHash);
      return [strategy, { uploads: after.length, reuploaded: changed.length, reuploadedRaw: changed.reduce((n, s) => n + s.raw, 0), reuploadedGzip: changed.reduce((n, s) => n + s.gzip, 0), changed: changed.map((s) => `${s.name} (${s.raw})`) }];
    }),
  );
}

/** Approach 2: what Effect a CRUD read script imports (bytes in output per module), against Effect's floor. */
async function effectBreakdown(app: string, l: Link) {
  const s = l.scripts.find((x) => x.members.includes("GET /v1/customers/{id}"))!;
  const dir = join(app, "generated/linked/per-entry-point", s.name);
  const opts = { absWorkingDir: app, bundle: true, write: false, metafile: true, format: "esm", platform: "neutral", target: "es2022", mainFields: ["module", "main"], conditions: ["source", "workerd", "worker", "browser", "import"], external: ["cloudflare:*", "node:*"], nodePaths: [join(app, "node_modules")], minify: true, legalComments: "none", charset: "utf8", logLevel: "silent" } as const;
  const r = await build({ ...opts, entryPoints: [join(dir, "entry.mjs")], alias: { "@forgegraph/linker-packed/host": join(root, "packages/linker-packed/src/host.ts") } });
  const inputs = Object.values(r.metafile.outputs)[0]!.inputs;
  const modules = Object.entries(inputs)
    .filter(([f, v]) => v.bytesInOutput && /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?effect\//.test(f))
    .map(([f, v]) => [f.replace(/.*\/effect\//, "effect/"), v.bytesInOutput] as const)
    .sort((a, b) => b[1] - a[1]);
  const floorOf = async (contents: string) => (await build({ ...opts, metafile: false, stdin: { contents, resolveDir: app, sourcefile: "floor.mjs" } })).outputFiles[0]!.contents.byteLength;
  const floor = {
    "Effect.runPromise(Effect.succeed(1))": await floorOf(`import { Effect } from "effect"; export default () => Effect.runPromise(Effect.succeed(1));`),
    "a service through a Layer (what the engine needs)": await floorOf(`import { Cause, Context, Effect, Layer } from "effect"; class S extends Context.Service()("s") {} const l = Layer.mergeAll(Layer.succeed(S)({ a: 1 })); export default () => Effect.runPromise(Effect.gen(function* () { return (yield* S).a; }).pipe(Effect.provide(l), Effect.catchCause((c) => Effect.succeed(Cause.pretty(c)))));`),
    "a js unit's own imports (Effect.gen, defineFunction)": await floorOf(`import { Effect } from "effect"; import { defineFunction } from "@forgegraph/runtime"; export default defineFunction("x", (d) => Effect.gen(function* () { return yield* Effect.succeed(d.input); }));`),
  };
  const total = modules.reduce((n, [, b]) => n + b, 0);
  return { script: s.name, effectBytes: total, modules: modules.length, top: Object.fromEntries(modules.slice(0, 15)), floor, aboveFloor: total - floor["a service through a Layer (what the engine needs)"] };
}

// --- RPC crossings per request (Node: the shared script and the runtime Worker wired directly) ---

async function crossings(app: string, l: Link) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql"].flatMap(() => execFileSync("ls", [join(app, "migrations/d1")], { encoding: "utf8" }).trim().split("\n")).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(app, "migrations/d1", f), "utf8").split("\n").filter((x) => !x.trim().startsWith("--")).join("\n");
    for (const st of sql.split(/;\s*\n/).map((x) => x.trim()).filter((x) => x && !/^PRAGMA/i.test(x))) db.exec(st);
  }
  type P = Parameters<ReturnType<typeof db.prepare>["get"]>;
  const stmt = (sql: string, params: unknown[] = []): any => ({ sql, params, bind: (...v: unknown[]) => stmt(sql, v), first: async () => db.prepare(sql).get(...(params as P)) ?? null, all: async () => ({ results: db.prepare(sql).all(...(params as P)) }), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as P)).changes) } }) });
  const DB = { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => { db.exec("BEGIN"); try { const out = ss.map((s) => ({ results: [], meta: { changes: Number(db.prepare(s.sql).run(...(s.params as P)).changes) } })); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } } };
  class Rpc {}
  class Entrypoint {}
  const Runtime = sharedRuntime(Entrypoint, Rpc) as unknown as new () => Record<string, (...a: unknown[]) => Promise<any>>;
  const runtime = new Runtime();
  const env: Record<string, unknown> = { DB, CURSOR_SECRET: "x", FORGE_AUTH: "dev-headers", Q_FULFILL_ORDER: { send: async () => undefined }, FORGE_DISPATCH: { fetch: async () => new Response(null, { status: 204 }) } };
  const counts: Record<string, number> = {};
  const counted = (caps: Record<string, (...a: unknown[]) => unknown>) => new Proxy(caps, { get: (t, k) => { const v = Reflect.get(t, k); return typeof v === "function" ? (...a: unknown[]) => { counts[String(k)] = (counts[String(k)] ?? 0) + 1; return (v as Function).apply(t, a); } : v; } });
  env["FORGE_RUNTIME"] = { serve: (req: unknown, caps: any, ...rest: unknown[]) => { counts["serve"] = (counts["serve"] ?? 0) + 1; return runtime["serve"]!(req, counted(caps), ...rest); } };
  const hostOf = async (member: string) => {
    const s = l.scripts.find((x) => x.members.includes(member))!;
    const dir = join(app, "generated/linked/per-entry-point-shared", s.name);
    const entry = readFileSync(join(dir, "entry.mjs"), "utf8");
    const config = JSON.parse(/packedShared\(RpcTarget, app, .*?, (\{"script".*?\}), (\{"script".*\})\);/.exec(entry)![1]!) as HostConfig;
    const meta = JSON.parse(/packedShared\(RpcTarget, app, .*?, \{"script".*?\}, (\{"script".*\})\);/.exec(entry)![1]!) as SharedMeta;
    const slice = JSON.parse(readFileSync(join(dir, "app.slice.json"), "utf8"));
    const modules = await Promise.all([...entry.matchAll(/import (u\d+) from "\.\/(units\/[0-9a-f]+\.js)";/g)].map(async (m) => [m[1]!, (await import(join(dir, m[2]!))).default] as const));
    const fns = [...(/unitHost\(\[(.*?)\]/.exec(entry)?.[1] ?? "").matchAll(/u\d+/g)].map((x) => modules.find(([n]) => n === x[0])![1]);
    const exts = Object.fromEntries([...(/\], \{ (.*?) \}\)/.exec(entry)?.[1] ?? "").matchAll(/("[^"]+"): (u\d+)/g)].map((x) => [JSON.parse(x[1]!), modules.find(([n]) => n === x[2])![1]]));
    return packedShared(Rpc, slice, fns.length || Object.keys(exts).length ? unitHost(fns, exts) : null, config, meta).worker;
  };
  const h = { "content-type": "application/json", "x-forge-tenant": "t1", "x-forge-actor": "a" };
  const send = async (member: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    for (const k of Object.keys(counts)) delete counts[k];
    const w = await hostOf(member);
    const res = await w.fetch(new Request(`https://forge.test${path}`, { method, headers: { ...h, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: () => undefined });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any>, counts: { ...counts } };
  };
  const c = await send("POST /v1/customers", "POST", "/v1/customers", { code: "CROSS1", name: "Cross" });
  const read = await send("GET /v1/customers/{id}", "GET", `/v1/customers/${c.json["id"]}`);
  const s = await send("POST /v1/sites", "POST", "/v1/sites", { customer: c.json["id"], code: "hq", name: "HQ", timezone: "UTC" });
  const o = await send("POST /v1/orders", "POST", "/v1/orders", { customer: c.json["id"], site: s.json["id"], subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
  const submit = await send("POST /v1/orders/{order}/submit", "POST", `/v1/orders/${o.json["id"]}/submit`, { expectedVersion: o.json["version"] }, { "if-match": `"${o.json["version"]}"` });
  const total = (x: Record<string, number>) => Object.values(x).reduce((n, v) => n + v, 0);
  const row = (r: typeof c) => ({ status: r.status, calls: r.counts, total: total(r.counts) });
  // `slice` appears once per runtime isolate and slice hash; the first request for a script pays it.
  return { note: "RPC calls per request, script <-> runtime Worker, counted in Node with the same modules (first request per script, so including the one-off slice fetch)", write: row(c), read: row(read), writeWithUnits: row(submit) };
}

// --- Latency in local workerd -------------------------------------------------------------------

async function latency(app: string, targets: Record<string, LocalScript[]>) {
  const env = readJsonc(join(app, "deploy/cloudflare/wrangler.jsonc")) as Environment;
  const h = { "content-type": "application/json", "x-forge-tenant": "lat", "x-forge-actor": "a" };
  let n = 0;
  const timed = async (url: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const t0 = performance.now();
    const res = await fetch(url + path, { method, headers: { ...h, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = (await res.json().catch(() => null)) as Record<string, any> | null;
    return { ms: performance.now() - t0, status: res.status, json };
  };
  const createCustomer = (url: string) => timed(url, "POST", "/v1/customers", { code: `LAT${String(++n).padStart(5, "0")}`, name: "Latency" });
  const out: Record<string, unknown> = {};
  for (const [name, scripts] of Object.entries(targets)) {
    const start = async () => {
      const t0 = performance.now();
      const s = await serve(scripts, env, { secret: "r3-latency", migrations: join(app, "migrations/d1") });
      return { s, startupMs: performance.now() - t0 };
    };
    const coldRead: number[] = [];
    const coldWrite: number[] = [];
    const startup: number[] = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      // Separate fresh instances, so neither measurement warms the other's scripts.
      let { s, startupMs } = await start();
      startup.push(startupMs);
      try {
        const r = await timed(s.url, "GET", "/v1/customers/cus_00000000000000000000000000");
        if (r.status !== 404) throw new Error(`${name}: cold read ${r.status}`);
        coldRead.push(r.ms);
      } finally {
        await s.close();
      }
      ({ s } = await start());
      try {
        const w = await createCustomer(s.url);
        if (w.status !== 201) throw new Error(`${name}: cold write ${w.status} ${JSON.stringify(w.json)}`);
        coldWrite.push(w.ms);
      } finally {
        await s.close();
      }
    }
    const sum = (xs: number[]) => ({ n: xs.length, median: +median(xs).toFixed(2), p95: +p95(xs).toFixed(2), min: +Math.min(...xs).toFixed(2) });
    out[name] = { scripts: scripts.length, startupMs: sum(startup), coldRead: sum(coldRead), coldWrite: sum(coldWrite) };
  }
  // Warm: every target served at once and the requests interleaved (A, B, C, A, B, C, ...), so load on
  // the machine lands on all of them alike; differences are also reported paired, request by request.
  const served = await Promise.all(Object.entries(targets).map(async ([name, scripts]) => ({ name, s: await serve(scripts, env, { secret: "r3-latency", migrations: join(app, "migrations/d1") }) })));
  try {
    const state = await Promise.all(
      served.map(async ({ name, s }) => {
        const seed = await createCustomer(s.url);
        const site = await timed(s.url, "POST", "/v1/sites", { customer: seed.json!["id"], code: "hq", name: "HQ", timezone: "UTC" });
        for (let i = 0; i < 5; i++) await timed(s.url, "GET", `/v1/customers/${seed.json!["id"]}`), await createCustomer(s.url);
        return { name, url: s.url, customer: seed.json!["id"] as string, site: site.json!["id"] as string, read: [] as number[], write: [] as number[], submit: [] as number[] };
      }),
    );
    for (let i = 0; i < WARM_RUNS; i++) {
      for (const t of state) {
        const r = await timed(t.url, "GET", `/v1/customers/${t.customer}`);
        if (r.status !== 200) throw new Error(`${t.name}: read ${r.status}`);
        t.read.push(r.ms);
      }
      for (const t of state) {
        const w = await createCustomer(t.url);
        if (w.status !== 201) throw new Error(`${t.name}: write ${w.status}`);
        t.write.push(w.ms);
      }
    }
    for (let i = 0; i < Math.ceil(WARM_RUNS / 2) + 1; i++) {
      for (const t of state) {
        const o = await timed(t.url, "POST", "/v1/orders", { customer: t.customer, site: t.site, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
        const sub = await timed(t.url, "POST", `/v1/orders/${o.json!["id"]}/submit`, { expectedVersion: o.json!["version"] }, { "if-match": `"${o.json!["version"]}"` });
        if (sub.status !== 200) throw new Error(`${t.name}: submit ${sub.status} ${JSON.stringify(sub.json)}`);
        if (i > 0) t.submit.push(sub.ms); // the first submit warms the script
      }
    }
    const sum = (xs: number[]) => ({ n: xs.length, median: +median(xs).toFixed(2), p95: +p95(xs).toFixed(2), min: +Math.min(...xs).toFixed(2) });
    const base = state.find((t) => t.name === "per-entry-point")!;
    for (const t of state) {
      const paired = (k: "read" | "write" | "submit") => +median(t[k].map((x, i) => x - base[k][i]!)).toFixed(2);
      Object.assign(out[t.name] as object, { warmRead: sum(t.read), warmWrite: sum(t.write), warmSubmit: sum(t.submit), pairedVsPerEntryPoint: { read: paired("read"), write: paired("write"), submit: paired("submit") } });
    }
  } finally {
    await Promise.all(served.map(({ s }) => s.close()));
  }
  return out;
}

try {
  const base = await buildAndLink(copyAcme());
  const bodyEdit = await buildAndLink(
    copyAcme((app) => {
      const f = join(app, "impl/rebuild-order-summary.ts");
      const text = readFileSync(f, "utf8");
      if (!text.includes("{ rebuilt: true }")) throw new Error("edit target moved");
      writeFileSync(f, text.replace("{ rebuilt: true }", "{ rebuilt: false }"));
    }),
  );
  const fromLink = (s: string) => scriptsOf(base.links[s]!, join(base.app, "generated/linked", s));
  const out = {
    version: "r3-runtime-cost/1",
    issue: "FORG-42",
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    measured: {
      toolchain: { ...base.manifest.toolchain, node: process.version, linker: base.links["per-entry-point"]!.linker },
      manifestHash: base.manifest.manifestHash,
      bundling: "esbuild, minified, format esm, platform neutral, conditions source/workerd/worker/browser/import, cloudflare:* and node:* external; gzip -9",
      sizes: Object.fromEntries(STRATEGIES.map(nameOf).map((s) => [s, summarize(base.links[s]!)])),
      bodyEdit: { edit: "impl/rebuild-order-summary.ts `{ rebuilt: true }` -> `{ rebuilt: false }`", ...bodyEditDiff(base, bodyEdit) },
      effect: await effectBreakdown(base.app, base.links["per-entry-point"]!),
      crossings: await crossings(base.app, base.links["per-entry-point-shared"]!),
      latency: {
        harness: `local workerd via Miniflare (packages/linker-packed/src/local.ts), loopback client wall time; cold = first request on a fresh instance (${COLD_RUNS} instances each for read and write); warm = ${WARM_RUNS} requests per target with all targets served at once and requests interleaved across them, after 5 warm-up pairs; pairedVsPerEntryPoint = median of request-by-request differences; read GET /v1/customers/{id}, write POST /v1/customers, plus POST /v1/orders/{order}/submit (2 js units, 1 transition)`,
        ...(await latency(base.app, { single: fromLink("single"), "per-entry-point": fromLink("per-entry-point"), "per-entry-point-shared": fromLink("per-entry-point-shared") })),
      },
    },
  };
  writeFileSync(join(here, "results/measure.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ sizes: Object.fromEntries(Object.entries(out.measured.sizes).map(([k, v]) => [k, { scripts: v.scripts, raw: v.raw, gzip: v.gzip, deployRaw: v.deployRaw, deployGzip: v.deployGzip }])), bodyEdit: Object.fromEntries(Object.entries(out.measured.bodyEdit).filter(([k]) => k !== "edit").map(([k, v]) => [k, { reuploaded: (v as any).reuploaded, raw: (v as any).reuploadedRaw, gzip: (v as any).reuploadedGzip }])), effect: { bytes: out.measured.effect.effectBytes, floor: out.measured.effect.floor }, crossings: out.measured.crossings, latency: out.measured.latency }, null, 2));
} finally {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}
