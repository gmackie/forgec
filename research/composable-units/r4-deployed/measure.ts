// FORG-38 measurements on the deployed lab (README). Run from anywhere, after the lab is deployed and
// the local prerequisites are built (forgec, acme sealed with `units:build`, linker B's libraries):
//
//   FORG38_SECRETS=/path/secrets.json node research/composable-units/r4-deployed/measure.ts <section>...
//
// Sections: rtt b-seed b c-nomanifest c-seed c rpc loader jspi eviction-b eviction-loader evict-many.
// Each writes results/<section>.json. The secrets file holds LAB_TOKEN, LINKER_ADMIN_TOKEN and
// TIER_STATS_TOKEN (the values ForgeGraph synced to the lab Workers); it is never committed. URLs
// default to the lab's workers.dev hostnames (lab/names.mjs) and can be overridden with B_URL, C_URL,
// TIER_URL and PROBE_URL (for example a local `wrangler dev`).
//
// Client wall times are from the machine running this script to the nearest Cloudflare colo
// (`rtt` measures the floor). Host times (x-forge-link-ms, x-lab-*-ms) are measured inside the
// Worker with Date.now()/performance.now(), which on deployed Workers advance only across I/O: they
// are wall time spent waiting on the child, D1 and R2, not CPU time. CPU time comes from Workers
// analytics (analytics.ts).
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, stableJson, writeSealed } from "../../../packages/units/src/index.ts";
// @ts-expect-error plain module
import { url as labUrl } from "./lab/names.mjs";

const here = import.meta.dirname;
const root = join(here, "../../..");
const acme = join(root, "examples/acme");
const unitsOut = join(acme, "generated/units");
const libsDir = join(root, "packages/linker-dynamic/generated/libs");
const secrets = JSON.parse(readFileSync(process.env["FORG38_SECRETS"] ?? "/tmp/forg38-lab/secrets.json", "utf8")) as Record<string, string>;
const B = process.env["B_URL"] ?? labUrl("linker-b");
const C = process.env["C_URL"] ?? labUrl("c-router");
const TIER = process.env["TIER_URL"] ?? labUrl("c-dynamic");
const PROBE = process.env["PROBE_URL"] ?? labUrl("probe");
const LAB = { "x-lab-token": secrets["LAB_TOKEN"]! };
const ADMIN = { ...LAB, "x-linker-admin": secrets["LINKER_ADMIN_TOKEN"]! };

const round = (x: number) => Math.round(x * 100) / 100;
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!) : null;
};
const summary = (xs: number[]) => ({ n: xs.length, min: q(xs, 0), median: q(xs, 0.5), p95: q(xs, 0.95), max: q(xs, 1) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const save = (name: string, data: unknown) => {
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", `${name}.json`), stableJson({ version: "r4-deployed/1", issue: "FORG-38", measured: "deployed", section: name, at: new Date().toISOString(), ...(data as object) }));
  console.log(`results/${name}.json`);
};

interface Timed {
  status: number;
  ms: number;
  json: any;
  h: Record<string, string>;
}
const KEEP = /^x-(forge|lab)-/;
async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Timed> {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: { ...LAB, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  const ms = performance.now() - t0;
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    if (KEEP.test(k)) h[k] = v;
  });
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, ms: round(ms), json, h };
}
const num = (v: string | undefined) => (v === undefined ? null : Number(v));
/** A compact record of one answer: what the measurement tables are built from. */
const rec = (r: Timed) => ({
  status: r.status,
  clientMs: r.ms,
  isolate: r.h["x-forge-isolate"] ?? null,
  linkMs: num(r.h["x-forge-link-ms"]),
  tier: r.h["x-forge-tier"] ?? null,
  miss: r.h["x-forge-tier-miss"] ?? null,
  closure: r.h["x-forge-closure"]?.slice(7, 19) ?? null,
  colo: r.h["x-lab-colo"] ?? null,
  hostIsolate: r.h["x-lab-b-isolate"] ?? r.h["x-lab-tier-isolate"] ?? null,
  hostMs: num(r.h["x-lab-b-ms"] ?? r.h["x-lab-tier-ms"]),
  routerIsolate: r.h["x-lab-router-isolate"] ?? null,
  routerMs: num(r.h["x-lab-router-ms"]),
  ...(r.status >= 300 ? { error: typeof r.json === "object" ? { code: r.json?.code, detail: String(r.json?.detail ?? "").slice(0, 300) } : String(r.json).slice(0, 300) } : {}),
});

// ------------------------------------------------------------------------------- acme requests
function acmeClient(base: string, tenant: string) {
  const H = { "x-forge-tenant": tenant, "x-forge-actor": "forg38" };
  let n = 0;
  const c = (method: string, path: string, body?: unknown) => call(base, method, path, body, H);
  const customer = async () => {
    n++;
    const r = await c("POST", "/v1/customers", { code: `L${Date.now().toString(36).slice(-5).toUpperCase()}${n}`, name: "Lab" });
    if (r.status !== 201) throw new Error(`customer: ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
    return r;
  };
  let site: { customer: string; site: string } | null = null;
  const draft = async (subtotal = "10.00") => {
    if (!site) {
      const cu = await customer();
      const s = await c("POST", "/v1/sites", { customer: cu.json.id, code: "hq", name: "HQ", timezone: "UTC" });
      if (s.status !== 201) throw new Error(`site: ${s.status} ${JSON.stringify(s.json).slice(0, 400)}`);
      site = { customer: cu.json.id, site: s.json.id };
    }
    const o = await c("POST", "/v1/orders", { customer: site.customer, site: site.site, subtotal, tax: "1.00", requestedOn: "2026-09-20" });
    if (o.status !== 201) throw new Error(`order: ${o.status} ${JSON.stringify(o.json).slice(0, 400)}`);
    return o;
  };
  const submit = (id: string) => c("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
  return { c, customer, draft, submit };
}

// ------------------------------------------------------------------------- unit store seeding
async function admin(base: string, method: string, path: string, body?: string | Uint8Array) {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: ADMIN, ...(body === undefined ? {} : { body: body as BodyInit }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 500)}`);
  return { ms: round(performance.now() - t0), json: JSON.parse(text) };
}
const libs = () => JSON.parse(readFileSync(join(libsDir, "libs.json"), "utf8")) as Record<string, { digest: string; file: string; bytes: number }>;
async function seedKit(base: string, salt?: string) {
  const libraries: Record<string, string> = {};
  const t0 = performance.now();
  for (const [name, l] of Object.entries(libs())) {
    let bytes: Uint8Array = readFileSync(join(libsDir, l.file));
    // A salted library: same code, different bytes, so every child id changes (a guaranteed loader miss).
    if (salt && name.startsWith("effect@")) bytes = Buffer.concat([bytes, Buffer.from(`\n//forg38-salt:${salt}\n`)]);
    libraries[name] = (await admin(base, "PUT", "/_linker/blobs", bytes)).json.digest;
  }
  const appBytes = readFileSync(join(acme, "generated/app.json"));
  const app = JSON.parse(appBytes.toString("utf8")) as { buildHash: string };
  const apps = { [app.buildHash]: (await admin(base, "PUT", "/_linker/blobs", appBytes)).json.digest };
  await admin(base, "PUT", "/_linker/kit", JSON.stringify({ libraries, apps }));
  return { ms: round(performance.now() - t0), libraries };
}
async function seedModules(base: string, dir = join(unitsOut, "modules")) {
  const t0 = performance.now();
  let n = 0;
  for (const f of readdirSync(dir)) {
    await admin(base, "PUT", "/_linker/blobs", readFileSync(join(dir, f)));
    n++;
  }
  return { ms: round(performance.now() - t0), modules: n };
}
const manifestText = () => readFileSync(join(unitsOut, "manifest.json"), "utf8");
const link = (base: string, text = manifestText()) => admin(base, "PUT", "/_linker/manifest", text);

/** acme's unit plan re-sealed from an edited copy of impl/ (as linker-dynamic's harness does). */
async function sealVariant(edit: (impl: string) => void) {
  const app = mkdtempSync(join(tmpdir(), "forg38-variant-"));
  cpSync(join(acme, "impl"), join(app, "impl"), { recursive: true });
  cpSync(join(acme, "src"), join(app, "src"), { recursive: true });
  cpSync(join(acme, "package.json"), join(app, "package.json"));
  symlinkSync(join(acme, "node_modules"), join(app, "node_modules"), "dir");
  edit(join(app, "impl"));
  const plan = JSON.parse(readFileSync(join(unitsOut, "plan.json"), "utf8"));
  const sealed = await seal(plan, app);
  const dir = join(app, "sealed");
  writeSealed(sealed, dir);
  return { dir, manifest: sealed.manifest as any, text: stableJson(sealed.manifest) };
}
const edit = (file: string, f: (s: string) => string) => (impl: string) => writeFileSync(join(impl, file), f(readFileSync(join(impl, file), "utf8")));
const raiseLimit = edit("payment-adapter.ts", (s) => s.replace("amount >= 1000", "amount >= 2000"));
const breakModule = edit("payment-adapter.ts", (s) => `${s}\nif (!(globalThis as Record<string, unknown>)["forgeNever"]) throw new Error("payment adapter failed to initialise");\n`);
const okOnly = (xs: any[], k: string) => summary(xs.filter((x) => x.status < 300).map((x) => x[k]).filter((x) => typeof x === "number"));
const uniq = (xs: any[], k: string) => [...new Set(xs.map((x) => x[k]))];

// ------------------------------------------------------------------------------------ sections
const sections: Record<string, () => Promise<void>> = {
  /** The floor: a lab Worker answering without touching the loader, D1 or another Worker. */
  async rtt() {
    const out: Record<string, unknown> = {};
    for (const [name, base] of [["linker-b", B], ["c-router", C], ["probe", PROBE]] as const) {
      const xs: number[] = [];
      let colo = null;
      for (let i = 0; i < 20; i++) {
        const r = await call(base, "GET", "/_lab/whoami");
        xs.push(r.ms);
        colo = r.json.colo;
      }
      out[name] = { clientMs: summary(xs.slice(1)), firstMs: xs[0], colo };
    }
    save("rtt", { note: "GET /_lab/whoami: the lab gate answers before the wrapped Worker; client wall time over the public internet", workers: out });
  },

  async "b-seed"() {
    const kit = await seedKit(B);
    const modules = await seedModules(B);
    const linked = await link(B);
    save("b-seed", { kitMs: kit.ms, modulesMs: modules.ms, modules: modules.modules, linkMs: linked.ms, link: linked.json });
  },

  /** Linker B: loader miss, warm, swap. Cold samples come from re-linking with a salted library (new child ids). */
  async b() {
    const ROUNDS = Number(process.env["ROUNDS"] ?? 6);
    const WARM = Number(process.env["WARM"] ?? 30);
    const tenant = `b-${Date.now().toString(36)}`;
    const a = acmeClient(B, tenant);
    await a.customer(); // tenant first-sight dispatch, outside the samples
    const cold: Record<string, any[]> = { read: [], write: [], orderCreate: [], submit: [] };
    const relinks: any[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const kit = await seedKit(B, `${tenant}-${i}`);
      const linked = await link(B);
      relinks.push({ kitMs: kit.ms, linkMs: linked.ms });
      cold.read!.push(rec(await a.c("GET", "/v1/customers")));
      cold.write!.push(rec(await a.customer()));
      const o = await a.draft();
      cold.orderCreate!.push(rec(o));
      cold.submit!.push(rec(await a.submit(o.json.id)));
      await sleep(500);
    }
    const warm: Record<string, any[]> = { read: [], write: [], orderCreate: [], submit: [] };
    for (let i = 0; i < WARM; i++) warm.read!.push(rec(await a.c("GET", "/v1/customers")));
    for (let i = 0; i < WARM; i++) warm.write!.push(rec(await a.customer()));
    for (let i = 0; i < Math.min(WARM, 15); i++) {
      const o = await a.draft();
      warm.orderCreate!.push(rec(o));
      warm.submit!.push(rec(await a.submit(o.json.id)));
    }
    // Swap: AuthorizePayment's limit 1000 -> 2000 (r3's edit). One module blob, one manifest PUT.
    const big = await a.draft("1501.00");
    const before = rec(await a.submit(big.json.id));
    const v = await sealVariant(raiseLimit);
    const current = JSON.parse(manifestText());
    const changed = Object.keys(v.manifest.modules).filter((m) => !current.modules[m]);
    const changedEntries = v.manifest.entryPoints.filter((e: any) => e.closureHash !== current.entryPoints.find((x: any) => x.id === e.id)?.closureHash).map((e: any) => e.id);
    const tUp = performance.now();
    for (const m of changed) await admin(B, "PUT", "/_linker/blobs", readFileSync(join(v.dir, v.manifest.modules[m].path)));
    const uploadMs = round(performance.now() - tUp);
    const swapped = await link(B, v.text);
    const afterRead = [rec(await a.c("GET", "/v1/customers")), rec(await a.c("GET", "/v1/customers"))];
    const afterWrite = [rec(await a.customer()), rec(await a.customer())];
    const afterSubmit: any[] = [];
    for (let i = 0; i < 6; i++) {
      const o = await a.draft("1501.00");
      const r = await a.submit(o.json.id);
      afterSubmit.push({ ...rec(r), state: r.json?.status ?? r.json?.code ?? null });
    }
    const relink = await link(B); // restore the sealed manifest
    const stats = (await (await fetch(`${B}/_linker/stats`, { headers: ADMIN })).json()) as any;
    save("b", {
      tenant,
      rounds: ROUNDS,
      relinks,
      coldSummary: Object.fromEntries(Object.entries(cold).map(([k, xs]) => [k, { clientMs: okOnly(xs, "clientMs"), linkMs: okOnly(xs, "linkMs"), hostMs: okOnly(xs, "hostMs"), statuses: uniq(xs, "status"), isolates: xs.map((x) => x.isolate), hostIsolates: uniq(xs, "hostIsolate") }])),
      warmSummary: Object.fromEntries(Object.entries(warm).map(([k, xs]) => [k, { clientMs: okOnly(xs, "clientMs"), linkMs: okOnly(xs, "linkMs"), hostMs: okOnly(xs, "hostMs"), statuses: uniq(xs, "status"), isolates: uniq(xs, "isolate"), hostIsolates: uniq(xs, "hostIsolate") }])),
      swap: { changedModules: changed.length, changedEntryPoints: changedEntries, uploadMs, linkMs: swapped.ms, manifestHash: swapped.json.manifestHash, before: { ...before, code: (before as any).error?.code ?? null }, afterRead, afterWrite, afterSubmit, restoredLinkMs: relink.ms },
      hostStats: { hostCodeCache: stats.hostCodeCache, closures: stats.closures.length, denials: stats.denials, refused: stats.refused.slice(-10) },
      cold,
      warm,
    });
  },

  /** Linker C before the tier host holds a manifest: every dynamic request falls back (NoManifest). */
  async "c-nomanifest"() {
    const a = acmeClient(C, `cn-${Date.now().toString(36)}`);
    const samples: any[] = [];
    for (let i = 0; i < 10; i++) samples.push(rec(await a.draft()));
    const packed: any[] = [];
    for (let i = 0; i < 10; i++) packed.push(rec(await a.c("GET", "/v1/customers")));
    save("c-nomanifest", { orderCreateClientMs: okOnly(samples, "clientMs"), tiers: uniq(samples, "tier"), misses: uniq(samples, "miss"), packedReadClientMs: okOnly(packed, "clientMs"), orderCreate: samples, packedRead: packed });
  },

  async "c-seed"() {
    const kit = await seedKit(TIER);
    const modules = await seedModules(TIER);
    const linked = await link(TIER);
    const tier = (await (await fetch(`${TIER}/_linker/tier`, { headers: ADMIN })).json()) as any;
    save("c-seed", { kitMs: kit.ms, modulesMs: modules.ms, linkMs: linked.ms, link: linked.json, tierHostManifestHash: tier.config.manifestHash, localManifestHash: JSON.parse(manifestText()).manifestHash, tier: tier.config });
  },

  /** Linker C: packed read and write, dynamic writes (first, then warm), and the LoadFailed fallback. */
  async c() {
    const WARM = Number(process.env["WARM"] ?? 30);
    const a = acmeClient(C, `c-${Date.now().toString(36)}`);
    const firstRead = rec(await a.c("GET", "/v1/customers"));
    const firstOrder = rec(await a.draft());
    const o1 = await a.draft();
    const firstSubmit = rec(await a.submit(o1.json.id));
    const read: any[] = [];
    const write: any[] = [];
    const order: any[] = [];
    const submit: any[] = [];
    for (let i = 0; i < WARM; i++) read.push(rec(await a.c("GET", "/v1/customers")));
    for (let i = 0; i < WARM; i++) write.push(rec(await a.customer()));
    for (let i = 0; i < Math.min(WARM, 15); i++) {
      const o = await a.draft();
      order.push(rec(o));
      submit.push(rec(await a.submit(o.json.id)));
    }
    // Fallback: a manifest whose AuthorizePayment module throws while it is evaluated.
    const broken = await sealVariant(breakModule);
    for (const m of Object.keys(broken.manifest.modules)) await admin(TIER, "PUT", "/_linker/blobs", readFileSync(join(broken.dir, broken.manifest.modules[m].path)));
    const brokenLink = await link(TIER, broken.text);
    const fallback: any[] = [];
    for (let i = 0; i < 10; i++) {
      const o = await a.draft();
      fallback.push(rec(await a.submit(o.json.id)));
    }
    const restored = await link(TIER);
    const afterRestore = rec(await a.submit((await a.draft()).json.id));
    const stats = (await (await fetch(`${C}/_forge/tiered/stats`, { headers: { ...LAB, "x-forge-tier-token": secrets["TIER_STATS_TOKEN"]! } })).json()) as any;
    const w = (xs: any[]) => ({ clientMs: okOnly(xs, "clientMs"), routerMs: okOnly(xs, "routerMs"), tierMs: okOnly(xs, "hostMs"), linkMs: okOnly(xs, "linkMs"), statuses: uniq(xs, "status"), tiers: uniq(xs, "tier"), isolates: uniq(xs, "isolate"), routerIsolates: uniq(xs, "routerIsolate") });
    save("c", {
      first: { read: firstRead, orderCreate: firstOrder, submit: firstSubmit },
      warmSummary: { "GET /v1/customers (packed)": w(read), "POST /v1/customers (packed)": w(write), "POST /v1/orders (dynamic)": w(order), "POST …/submit (dynamic)": w(submit) },
      fallback: { manifestHash: brokenLink.json.manifestHash, ...w(fallback), misses: uniq(fallback, "miss"), samples: fallback },
      restored: { linkMs: restored.ms, submit: afterRestore },
      routerStats: { ...stats, recent: (stats.recent ?? []).slice(-5) },
      samples: { read, write, order, submit },
    });
  },

  /** The 32-invocation limit: what counts. */
  async rpc() {
    const plan: Array<[string, number[]]> = [
      ["top", [10, 31, 32, 33, 40, 64, 100]],
      ["fetch", [31, 32, 33, 40]],
      ["callback", [10, 31, 32, 33, 40, 100, 1000]],
      ["fn", [40, 100]],
      ["chain", [8, 16, 30, 31, 32, 33, 40]],
    ];
    const runs: any[] = [];
    for (const [kind, ns] of plan) for (const n of ns) runs.push({ kind, n, ...(await call(PROBE, "GET", `/rpc/${kind}?n=${n}`)).json });
    for (const top of [1, 10, 31, 32, 40]) runs.push({ kind: "serve", n: 40, top, ...(await call(PROBE, "GET", `/rpc/serve?n=40&top=${top}`)).json });
    for (const r of runs) console.log(JSON.stringify(r).slice(0, 300));
    save("rpc", { runs });
  },

  /** The loader itself: cold and warm child cost by size, and load() against get(). */
  async loader() {
    const info = (await call(PROBE, "GET", "/loader/info")).json;
    const tag = Date.now().toString(36);
    const sizes: Record<string, unknown> = {};
    for (const pad of [0, 100_000, 850_000]) {
      const cold: any[] = [];
      const warm: any[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await call(PROBE, "GET", `/loader/get?id=sz-${tag}-${pad}-${i}&pad=${pad}`);
        cold.push({ clientMs: r.ms, ...r.json, probeIsolate: r.h["x-lab-isolate"] });
        for (let j = 0; j < 4; j++) {
          const x = await call(PROBE, "GET", `/loader/get?id=sz-${tag}-${pad}-${i}&pad=${pad}`);
          warm.push({ clientMs: x.ms, ...x.json, probeIsolate: x.h["x-lab-isolate"] });
        }
      }
      sizes[String(pad)] = { coldInParentMs: summary(cold.filter((x) => x.cold).map((x) => x.ms)), warmInParentMs: summary(warm.filter((x) => !x.cold).map((x) => x.ms)), firstCold: cold.map((x) => x.cold), laterCold: warm.filter((x) => x.cold).length, probeIsolates: uniq([...cold, ...warm], "probeIsolate"), cold, warm };
    }
    const loads: any[] = [];
    for (let i = 0; i < 5; i++) loads.push((await call(PROBE, "GET", "/loader/load")).json);
    save("loader", { info, sizes, load: { ms: summary(loads.map((x) => x.ms)), samples: loads } });
  },

  async jspi() {
    const probe = (await call(PROBE, "GET", "/jspi/probe")).json;
    const setup = (await call(PROBE, "POST", "/jspi/setup")).json;
    const cart = (items: number) => ({ items: Array.from({ length: items }, (_, i) => ({ product: `p-${i % 100}`, quantity: (i % 9) + 1 })) });
    const quote = { lines: [{ sku: "A-1", quantity: 3, unitPrice: "19.99" }, { sku: "B-2", quantity: 1, unitPrice: "120" }], tier: "gold", taxRateBasisPoints: 825, shipping: "7.5" };
    const out: Record<string, unknown> = {};
    for (const mode of ["static", "dynamic"]) {
      for (const [unit, input, label] of [["price-cart", cart(1), "1 item"], ["price-cart", cart(10), "10 items"], ["price-cart", cart(100), "100 items"], ["quote-order", quote, "quote"]] as const) {
        const xs: any[] = [];
        for (let i = 0; i < 10; i++) {
          const r = await call(PROBE, "POST", `/jspi/${mode}/${unit}/call`, input);
          xs.push({ status: r.status, clientMs: r.ms, hostMs: Number(r.h["x-lab-host-ms"]), child: r.h["x-lab-child"] ?? null, childMs: num(r.h["x-lab-child-ms"]), ok: r.json?.ok, value: i === 0 ? r.json : undefined });
        }
        out[`${mode} ${unit} ${label}`] = { ok: xs.every((x) => x.ok === true), first: xs[0], hostMs: summary(xs.slice(1).map((x) => x.hostMs)), clientMs: summary(xs.slice(1).map((x) => x.clientMs)), children: xs.map((x) => x.child) };
      }
    }
    const bench = await call(PROBE, "POST", "/jspi/static/price-cart/bench", { input: cart(10), n: 20 });
    save("jspi", { probe, setup, runs: out, bench: bench.json });
  },

  /** Child eviction on B: one closure (GET /v1/sites) touched only after growing idle gaps; whoami says whether the host isolate changed. */
  async "eviction-b"() {
    const gaps = (process.env["GAPS"] ?? "0,15,60,180,600,1200").split(",").map(Number);
    const a = acmeClient(B, `ev-${Date.now().toString(36)}`);
    const out: any[] = [];
    for (const g of gaps) {
      await sleep(g * 1000);
      const who = (await call(B, "GET", "/_lab/whoami")).json;
      const r = rec(await a.c("GET", "/v1/sites"));
      out.push({ gapS: g, whoami: who, ...r });
      console.log(JSON.stringify(out.at(-1)));
    }
    save("eviction-b", { closure: "GET /v1/sites", samples: out });
  },

  /** Child eviction in the probe: one trivial child re-hit after growing idle gaps. */
  async "eviction-loader"() {
    const gaps = (process.env["GAPS"] ?? "0,15,60,180,600,1200").split(",").map(Number);
    const tag = `ev-${Date.now().toString(36)}`;
    const out: any[] = [];
    for (const g of gaps) {
      await sleep(g * 1000);
      const r = await call(PROBE, "GET", `/loader/get?id=${tag}&pad=100000`);
      out.push({ gapS: g, clientMs: r.ms, probeIsolate: r.h["x-lab-isolate"], colo: r.h["x-lab-colo"], ...r.json });
      console.log(JSON.stringify(out.at(-1)));
    }
    save("eviction-loader", { samples: out });
  },

  /** Induced eviction: load N distinct children, then re-hit them all. */
  async "evict-many"() {
    const N = Number(process.env["N"] ?? 120);
    const pad = Number(process.env["PAD"] ?? 100_000);
    const tag = `m-${Date.now().toString(36)}`;
    const rounds: any[] = [];
    for (const pass of [0, 1]) {
      const loads: any[] = [];
      for (let from = 0; from < N; from += 20) {
        const r = await call(PROBE, "GET", `/loader/many?prefix=${tag}&from=${from}&n=${Math.min(20, N - from)}&pad=${pad}`);
        loads.push({ probeIsolate: r.h["x-lab-isolate"], ...r.json });
      }
      const all = loads.flatMap((l) => l.loads ?? []);
      rounds.push({ pass, cold: all.filter((x: any) => x.cold).length, errors: all.filter((x: any) => x.error).map((x: any) => x.error).slice(0, 3), probeIsolates: uniq(loads, "probeIsolate"), coldIds: pass === 0 ? `${all.filter((x: any) => x.cold).length} ids` : all.filter((x: any) => x.cold).map((x: any) => x.id), coldMs: summary(all.filter((x: any) => x.cold).map((x: any) => x.ms)), warmMs: summary(all.filter((x: any) => !x.cold && !x.error).map((x: any) => x.ms)) });
    }
    save("evict-many", { n: N, padBytes: pad, rounds });
  },
};

for (const s of process.argv.slice(2)) {
  if (!sections[s]) throw new Error(`unknown section ${s}; one of ${Object.keys(sections).join(", ")}`);
  console.log(`== ${s}`);
  await sections[s]!();
}
