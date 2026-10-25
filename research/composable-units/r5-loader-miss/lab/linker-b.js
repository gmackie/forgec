// FORG-48 lab entry: linker B's host (packages/linker-dynamic/src/host.ts) behind FORG-38's lab gate, plus
// lab-only probes. The host is unchanged; LINKER_UNIT_CACHE (set per Worker in build.mjs) picks its unit
// fetch layers. Secrets arrive renamed (names.mjs SECRETS) and are mapped back before the gate and host see env.
//
// Probes (token required, like everything behind the gate):
//   POST /_lab/miss?layers=code|code,memory&path=/v1/customers&tenant=t[&relink=1, body = manifest]
//        One host isolate, one request: optionally re-link (so this isolate reads the current kit), evict the
//        host caches (which also makes the next child id new), then the loader miss and a warm repeat, each
//        timed, with the host's breakdown header and the build's per-blob report from /_linker/stats.
//   GET  /_lab/r2[?parallel=1]   raw R2 latency of kit.json and every kit blob (get + body), serial or parallel
//   GET  /_lab/cache             whether the Cache API keeps an entry on this hostname (put, then match)
//   GET  /_lab/d1?n=20           n sequential `SELECT 1` on D1, each timed: the per-statement round trip
//   GET  /_lab/floor?n=5         the child cold start, split: a Dynamic Worker with an empty main, then with the
//        runtime and Effect, then app.json too (as { json } or as { text } parsed in the child), then
//        createWorker(app) as linker B's children run it, then one request through it (no auth headers and no bindings: the runtime answers 401 before storage). Each variant n times with new ids, cold then warm.
import host from "../../../../packages/linker-dynamic/src/host.ts";
import { labGate } from "../../r4-deployed/lab/gate.js";
import { SECRETS } from "./names.mjs";

// FORG-47: the manifest pointer's Durable Object, bound as LINKER_POINTER (build.mjs).
export { D1Gate, Egress, ManifestPointer, ObjectsGate, QueueGate, WorkflowGate } from "../../../../packages/linker-dynamic/src/host.ts";

const renamed = new WeakMap();
function labEnv(env) {
  let e = renamed.get(env);
  if (!e) {
    e = { ...env };
    for (const [to, from] of Object.entries(SECRETS)) if (env[from] !== undefined) e[to] = env[from];
    renamed.set(env, e);
  }
  return e;
}

const breakdown = (r) => Object.fromEntries((r.headers.get("x-forge-link-breakdown") ?? "").split(";").filter(Boolean).map((kv) => kv.split("=")).map(([k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)]));

async function timed(f) {
  const t0 = Date.now();
  const r = await f();
  const body = await r.text();
  return { ms: Date.now() - t0, status: r.status, r, body };
}

async function miss(request, env, ctx, url) {
  const origin = url.origin;
  const admin = { "x-linker-admin": env.LINKER_ADMIN_TOKEN };
  const out = {};
  if (url.searchParams.get("relink") === "1") {
    const text = await request.text();
    const r = await timed(() => host.fetch(new Request(`${origin}/_linker/manifest`, { method: "PUT", headers: admin, body: text }), env, ctx));
    if (r.status !== 200) return Response.json({ step: "relink", status: r.status, body: r.body.slice(0, 500) }, { status: 502 });
    out.relink = { ms: r.ms, ...JSON.parse(r.body) };
  }
  const layers = url.searchParams.get("layers") ?? "code,memory";
  const ev = await timed(() => host.fetch(new Request(`${origin}/_linker/evict-host-cache?layers=${layers}`, { method: "POST", headers: admin }), env, ctx));
  out.evict = JSON.parse(ev.body);
  const path = url.searchParams.get("path") ?? "/v1/customers";
  const method = url.searchParams.get("method") ?? "GET";
  const tenant = url.searchParams.get("tenant") ?? "forg48";
  const req = () => new Request(`${origin}${path}`, { method, headers: { "x-forge-tenant": tenant, "x-forge-actor": "forg48", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify({ code: `M${Date.now().toString(36).slice(-6).toUpperCase()}${Math.floor(Math.random() * 1e4)}`, name: "Miss" }) }) });
  const m = await timed(() => host.fetch(req(), env, ctx));
  const w = await timed(() => host.fetch(req(), env, ctx));
  const stats = JSON.parse((await timed(() => host.fetch(new Request(`${origin}/_linker/stats`, { headers: admin }), env, ctx))).body);
  const entry = m.r.headers.get("x-forge-entry");
  const closure = stats.closures.filter((c) => c.label === `http-route:${entry}` || c.label === entry).flatMap((c) => c.fetches ?? []).at(-1) ?? null;
  out.miss = { status: m.status, ms: m.ms, isolate: m.r.headers.get("x-forge-isolate"), linkMs: Number(m.r.headers.get("x-forge-link-ms")), breakdown: breakdown(m.r), fetch: closure, ...(m.status >= 300 ? { body: m.body.slice(0, 500) } : {}) };
  out.warm = { status: w.status, ms: w.ms, isolate: w.r.headers.get("x-forge-isolate"), linkMs: Number(w.r.headers.get("x-forge-link-ms")), breakdown: breakdown(w.r) };
  out.unitFetch = stats.unitFetch;
  return Response.json(out);
}

async function r2(env, url) {
  const parallel = url.searchParams.get("parallel") === "1";
  const ops = [];
  const op = async (key) => {
    const t0 = Date.now();
    const o = await env.UNITS.get(key);
    const tFirst = Date.now();
    const bytes = o ? (await o.arrayBuffer()).byteLength : null;
    ops.push({ key: key.slice(0, 18), bytes, ms: Date.now() - t0, firstByteMs: tFirst - t0 });
  };
  const t0 = Date.now();
  await op("kit.json");
  const kit = JSON.parse(await (await env.UNITS.get("kit.json")).text());
  const keys = [...Object.values(kit.libraries), ...Object.values(kit.apps)].map((d) => `blobs/${d.slice(7)}`);
  const tBlobs = Date.now();
  if (parallel) await Promise.all(keys.map(op));
  else for (const k of keys) await op(k);
  const tHead = Date.now();
  await env.UNITS.head(keys[0]);
  return Response.json({ parallel, ops, blobsMs: tHead - tBlobs, headMs: Date.now() - tHead, totalMs: Date.now() - t0 });
}

async function cacheProbe() {
  const c = await caches.open("forge-lab-miss-probe");
  const key = `https://units.forge-linker.invalid/probe/${crypto.randomUUID()}`;
  const t0 = Date.now();
  await c.put(key, new Response("x".repeat(1024), { headers: { "cache-control": "public, max-age=600" } }));
  const tPut = Date.now();
  const hit = await c.match(key);
  const tMatch = Date.now();
  // the default cache too, with the same kind of key
  await caches.default.put(key, new Response("y", { headers: { "cache-control": "public, max-age=600" } }));
  const hitDefault = await caches.default.match(key);
  return Response.json({ named: { hit: !!hit, putMs: tPut - t0, matchMs: tMatch - tPut }, default: { hit: !!hitDefault } });
}

async function floor(env, url) {
  const n = Math.min(10, Number(url.searchParams.get("n") ?? 5));
  const kit = JSON.parse(await (await env.UNITS.get("kit.json")).text());
  const blob = async (d) => (await env.UNITS.get(`blobs/${d.slice(7)}`)).text();
  const lib = (name) => Object.entries(kit.libraries).find(([k]) => k.startsWith(`${name}@`))[1];
  const [runtime, effect, appText] = await Promise.all([blob(lib("@forgegraph/runtime")), blob(lib("effect")), blob(Object.values(kit.apps)[0])]);
  const app = JSON.parse(appText);
  const libs = { "@forgegraph/runtime": { js: runtime }, effect: { js: effect } };
  const ok = `export default { fetch: () => new Response(String(typeof x === "undefined" ? 0 : 1)) };`;
  const variants = {
    empty: { "main.js": `const x = undefined;\n${ok}` },
    libraries: { "main.js": `import { createWorker as x } from "@forgegraph/runtime";\n${ok}`, ...libs },
    "libraries+app(json)": { "main.js": `import { createWorker } from "@forgegraph/runtime";\nimport app from "./app.json";\nconst x = [createWorker, app.buildHash];\n${ok}`, ...libs, "app.json": { json: app } },
    "libraries+app(text)": { "main.js": `import { createWorker } from "@forgegraph/runtime";\nimport text from "./app.txt";\nconst x = [createWorker, JSON.parse(text).buildHash];\n${ok}`, ...libs, "app.txt": { text: appText } },
    createWorker: { "main.js": `import { createWorker } from "@forgegraph/runtime";\nimport app from "./app.json";\nconst x = createWorker(app, { functions: [], externals: {}, postCommit: async () => undefined });\n${ok}`, ...libs, "app.json": { json: app } },
    // and one request through the runtime that needs no binding (no auth headers: 401 before storage)
    "createWorker+request": { "main.js": `import { createWorker } from "@forgegraph/runtime";\nimport app from "./app.json";\nconst w = createWorker(app, { functions: [], externals: {}, postCommit: async () => undefined });\nexport default { fetch: async () => { const r = await w.fetch(new Request("http://child/v1/no-such-route"), {}); return new Response(String(r.status)); } };`, ...libs, "app.json": { json: app } },
  };
  const tag = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  const out = {};
  for (const [name, modules] of Object.entries(variants)) {
    const cold = [];
    const warm = [];
    for (let i = 0; i < n; i++) {
      let built = false;
      const id = `floor-${name}-${tag}-${i}`;
      const t0 = Date.now();
      const stub = env.LOADER.get(id, () => ((built = true), { compatibilityDate: "2026-09-25", mainModule: "main.js", modules, env: {}, globalOutbound: null }));
      const r = await stub.getEntrypoint().fetch("http://child/");
      const body = await r.text();
      cold.push({ ms: Date.now() - t0, built, body, status: r.status });
      const t1 = Date.now();
      await (await stub.getEntrypoint().fetch("http://child/")).text();
      warm.push(Date.now() - t1);
    }
    out[name] = { cold, warm };
  }
  return Response.json({ n, bytes: { runtime: runtime.length, effect: effect.length, app: appText.length }, variants: out });
}

async function d1(env, url) {
  const n = Math.min(100, Number(url.searchParams.get("n") ?? 20));
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    await env.DB.prepare("SELECT 1 AS one").first();
    ms.push(Date.now() - t0);
  }
  return Response.json({ n, ms });
}

const inner = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/_lab/miss" && request.method === "POST") return miss(request, env, ctx, url);
    if (url.pathname === "/_lab/r2") return r2(env, url);
    if (url.pathname === "/_lab/cache") return cacheProbe();
    if (url.pathname === "/_lab/d1") return d1(env, url);
    if (url.pathname === "/_lab/floor") return floor(env, url);
    return host.fetch(request, env, ctx);
  },
};

const gated = labGate(inner, "b");
export default { fetch: (request, env, ctx) => gated.fetch(request, labEnv(env), ctx) };
