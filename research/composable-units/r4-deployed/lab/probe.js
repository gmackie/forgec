// FORG-38 lab probe Worker: three questions that need no linker.
//
//   /rpc/*     the 32-invocation limit: which cross-script calls count (CALLEE is lab/rpc-callee.js)
//   /loader/*  the Worker Loader itself: availability, cold and warm child cost, reuse and eviction
//   /jspi/*    examples/pricing's WASM components with async capability imports (JSPI), run statically
//              (the units harness's own modules, uploaded with this script) and in a Dynamic Worker
//
// Every route but /_lab/health (the deploy probe) needs `x-lab-token: <LAB_TOKEN>`. Built by ../build.mjs, which generates
// ./generated/jspi.js (the harness modules for the dynamic copy) and the static caller modules.
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import priceCartStatic from "./price-cart/caller.js";
import quoteOrderStatic from "./quote-order/caller.js";
import { JSPI_UNITS, D1_SCHEMA, CATALOG, PRODUCT } from "./generated/jspi.js";
// (module (import "host" "get" (func (param i32) (result i32))) (func (export "run") ... get(x) + 1)): r2-wasm-async's probe.
import PROBE_MODULE from "./probe.wasm";

let isolate = null;
let started = 0;
const identity = (request) => {
  if (!isolate) {
    isolate = crypto.randomUUID().slice(0, 8);
    started = Date.now();
  }
  return { isolate, ageMs: Date.now() - started, colo: request.cf?.colo ?? null };
};
const int = (url, k, d) => Number(url.searchParams.get(k) ?? d);

// ------------------------------------------------------------------------------- invocation limit
class Caps extends RpcTarget {
  constructor(env) {
    super();
    this.env = env;
    this.calls = 0;
  }
  async noop() {
    this.calls++;
    return 0;
  }
  async d1(sql) {
    this.calls++;
    return sql.length;
  }
  /** One level of /rpc/chain: a fresh top-level call from the caller into the callee. */
  async chain(depth) {
    this.calls++;
    return this.env.CALLEE.chain(this, depth);
  }
}

/**
 * Nested invocations: each hop is a new invocation of this Worker through its own loopback service
 * binding (ctx.exports), nested inside the last, `n` deep. `hop` is Workers RPC; `fetchHop` is fetch().
 */
export class Hop extends WorkerEntrypoint {
  async hop(n) {
    if (n <= 0) return 0;
    return 1 + (await this.ctx.exports.Hop({ props: {} }).hop(n - 1));
  }
  async fetch(request) {
    const n = Number(new URL(request.url).searchParams.get("n"));
    if (n <= 0) return Response.json({ depth: 0 });
    const r = await this.ctx.exports.Hop({ props: {} }).fetch(`https://hop/?n=${n - 1}`);
    if (!r.ok) return new Response(await r.text(), { status: r.status });
    return Response.json({ depth: 1 + (await r.json()).depth });
  }
}

async function rpc(url, env, ctx) {
  const n = int(url, "n", 40);
  const kind = url.pathname.slice("/rpc/".length);
  const out = { kind, n };
  const t0 = Date.now();
  try {
    if (kind === "top") {
      // n sequential top-level RPC calls from this request to the callee.
      let done = 0;
      try {
        for (; done < n; done++) await env.CALLEE.noop();
      } catch (e) {
        out.error = String(e);
      }
      out.done = done;
    } else if (kind === "fetch") {
      let done = 0;
      try {
        for (; done < n; done++) await (await env.CALLEE.fetch("https://callee/")).arrayBuffer();
      } catch (e) {
        out.error = String(e);
      }
      out.done = done;
    } else if (kind === "callback") {
      // One top-level call; the callee calls back into an RpcTarget stub n times.
      const caps = new Caps(env);
      Object.assign(out, await env.CALLEE.callbacks(caps, n));
      out.callerSaw = caps.calls;
    } else if (kind === "fn") {
      let seen = 0;
      Object.assign(out, await env.CALLEE.fnCallbacks(() => ++seen, n));
      out.callerSaw = seen;
    } else if (kind === "serve") {
      // FORG-42's shape: `top` top-level serve() calls, each making n capability callbacks.
      const top = int(url, "top", 1);
      out.top = top;
      out.serves = [];
      const caps = new Caps(env);
      for (let i = 0; i < top; i++) {
        try {
          out.serves.push(await env.CALLEE.serve(caps, n));
        } catch (e) {
          out.serves.push({ error: String(e) });
          break;
        }
      }
      out.callerSaw = caps.calls;
    } else if (kind === "depth") {
      try {
        out.depth = await ctx.exports.Hop({ props: {} }).hop(n);
      } catch (e) {
        out.error = String(e);
      }
    } else if (kind === "fdepth") {
      const r = await ctx.exports.Hop({ props: {} }).fetch(`https://hop/?n=${n}`);
      out.status = r.status;
      out.body = (await r.text()).slice(0, 300);
    } else if (kind === "chain") {
      const caps = new Caps(env);
      try {
        out.result = await env.CALLEE.chain(caps, n);
      } catch (e) {
        out.error = String(e);
      }
      out.callerSaw = caps.calls;
    } else return Response.json({ code: "NotFound" }, { status: 404 });
  } catch (e) {
    out.thrown = String(e);
  }
  out.ms = Date.now() - t0;
  return Response.json(out);
}

// ----------------------------------------------------------------------------- the Worker Loader
/** A child of `pad` bytes of dead code, reporting its own isolate identity. Same id => same code. */
function trivialChild(id, pad) {
  return {
    compatibilityDate: "2026-09-25",
    mainModule: "main.js",
    modules: {
      "main.js": `let iso = null, t = 0, n = 0;
const padding = ${JSON.stringify("x".repeat(pad))};
export default { async fetch() { if (!iso) { iso = crypto.randomUUID().slice(0, 8); t = Date.now(); } n++; return Response.json({ id: ${JSON.stringify(id)}, isolate: iso, ageMs: Date.now() - t, requests: n, padding: padding.length }); } };`,
    },
    env: {},
    globalOutbound: null,
  };
}

async function loadOne(env, id, pad) {
  let cold = false;
  const t0 = Date.now();
  const stub = env.LOADER.get(id, () => {
    cold = true;
    return trivialChild(id, pad);
  });
  const child = await (await stub.getEntrypoint().fetch("https://child/")).json();
  return { id, cold, ms: Date.now() - t0, child: { isolate: child.isolate, ageMs: child.ageMs, requests: child.requests } };
}

async function loader(url, env) {
  const kind = url.pathname.slice("/loader/".length);
  if (!env.LOADER) return Response.json({ available: false, binding: typeof env.LOADER });
  const pad = int(url, "pad", 0);
  if (kind === "info") return Response.json({ available: true, binding: Object.prototype.toString.call(env.LOADER), methods: Object.getOwnPropertyNames(Object.getPrototypeOf(env.LOADER)) });
  if (kind === "get") return Response.json(await loadOne(env, url.searchParams.get("id") ?? "lab-1", pad));
  if (kind === "many") {
    // Ids prefix-0 .. prefix-(n-1), sequentially, one request: how many were cold, and the cost of each.
    const prefix = url.searchParams.get("prefix") ?? "lab";
    const n = int(url, "n", 10);
    const from = int(url, "from", 0);
    const out = [];
    for (let i = from; i < from + n; i++) {
      try {
        out.push(await loadOne(env, `${prefix}-${i}`, pad));
      } catch (e) {
        out.push({ id: `${prefix}-${i}`, error: String(e) });
        break;
      }
    }
    return Response.json({ n: out.length, cold: out.filter((x) => x.cold).length, errors: out.filter((x) => x.error).length, loads: out });
  }
  if (kind === "hold") {
    // One long request keeps this parent isolate alive while one child idles for growing gaps: a cold
    // re-hit here is the loader evicting a child whose parent is still running.
    const id = url.searchParams.get("id") ?? `hold-${Date.now()}`;
    const gaps = (url.searchParams.get("gaps") ?? "0,10,30,60").split(",").map(Number);
    const out = [];
    for (const g of gaps) {
      await scheduler.wait(g * 1000);
      out.push({ gapS: g, ...(await loadOne(env, id, pad)) });
    }
    return Response.json({ id, samples: out });
  }
  if (kind === "load") {
    // load(): never cached.
    const t0 = Date.now();
    const w = env.LOADER.load(trivialChild("load", pad));
    const child = await (await w.getEntrypoint().fetch("https://child/")).json();
    return Response.json({ ms: Date.now() - t0, child });
  }
  return Response.json({ code: "NotFound" }, { status: 404 });
}

// ---------------------------------------------------------------------------------------- JSPI
/** The D1 handle a dynamic JSPI child gets: one method, the harness host's one query. */
export class HarnessDb extends WorkerEntrypoint {
  async first(sql, params) {
    return this.env.DB.prepare(sql).bind(...params).first();
  }
}

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
function dynamicCode(unit) {
  const modules = {};
  for (const m of unit.modules) {
    if (m.type === "CompiledWasm") modules[m.path] = { wasm: b64(m.b64) };
    else modules[m.path] = { js: new TextDecoder().decode(b64(m.b64)) };
  }
  return { compatibilityDate: "2026-09-25", mainModule: "caller.js", modules };
}

async function jspi(request, url, env, ctx) {
  const parts = url.pathname.split("/"); // ["", "jspi", mode, unit, ...rest]
  const mode = parts[2];
  if (mode === "setup") {
    await env.DB.prepare(D1_SCHEMA).run();
    await env.DB.batch(CATALOG.map((p) => env.DB.prepare("INSERT OR REPLACE INTO forge_harness_records (resource, id, body) VALUES (?, ?, ?)").bind(PRODUCT, p.id, JSON.stringify(p))));
    return Response.json({ ok: true, products: CATALOG.length });
  }
  if (mode === "probe") {
    // Raw JSPI on this isolate, no jco: does WebAssembly.Suspending suspend for real? (Workers refuse
    // runtime compilation, so the module is uploaded as a CompiledWasm module.)
    const out = { Suspending: typeof WebAssembly.Suspending, promising: typeof WebAssembly.promising };
    try {
      const get = new WebAssembly.Suspending(async (x) => {
        await scheduler.wait(1);
        return x * 2;
      });
      out.result = await WebAssembly.promising((await WebAssembly.instantiate(PROBE_MODULE, { host: { get } })).exports.run)(20);
    } catch (e) {
      out.error = String(e);
    }
    try {
      await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      out.runtimeCompile = "allowed";
    } catch (e) {
      out.runtimeCompile = String(e);
    }
    out.works = out.result === 41;
    return Response.json(out);
  }
  const name = parts[3];
  const rest = "/" + parts.slice(4).join("/");
  const forwarded = new Request(new URL(rest, "https://unit"), request);
  if (mode === "static") {
    const target = name === "price-cart" ? priceCartStatic : name === "quote-order" ? quoteOrderStatic : null;
    if (!target) return Response.json({ code: "NotFound" }, { status: 404 });
    return target.fetch(forwarded, env, ctx);
  }
  if (mode === "dynamic") {
    const unit = JSPI_UNITS[name];
    if (!unit) return Response.json({ code: "NotFound" }, { status: 404 });
    let cold = false;
    const t0 = Date.now();
    const stub = env.LOADER.get(`jspi:${name}:${unit.digest}`, () => {
      cold = true;
      return { ...dynamicCode(unit), env: { DB: ctx.exports.HarnessDb({ props: {} }) }, globalOutbound: null };
    });
    const res = await stub.getEntrypoint().fetch(forwarded);
    const out = new Response(res.body, res);
    out.headers.set("x-lab-child", cold ? "cold" : "warm");
    out.headers.set("x-lab-child-ms", String(Date.now() - t0));
    return out;
  }
  return Response.json({ code: "NotFound" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const id = identity(request);
    if (new URL(request.url).pathname === "/_lab/health") return new Response("ok");
    if (!env.LAB_TOKEN || request.headers.get("x-lab-token") !== env.LAB_TOKEN) return new Response("not found", { status: 404 });
    const url = new URL(request.url);
    const t0 = Date.now();
    let res;
    if (url.pathname === "/_lab/whoami") res = Response.json(id);
    else if (url.pathname.startsWith("/rpc/")) res = await rpc(url, env, ctx);
    else if (url.pathname.startsWith("/loader/")) res = await loader(url, env);
    else if (url.pathname.startsWith("/jspi/")) res = await jspi(request, url, env, ctx);
    else res = Response.json({ code: "NotFound" }, { status: 404 });
    const out = new Response(res.body, res);
    out.headers.set("x-lab-isolate", id.isolate);
    out.headers.set("x-lab-colo", String(id.colo));
    out.headers.set("x-lab-host-ms", String(Date.now() - t0));
    return out;
  },
};
