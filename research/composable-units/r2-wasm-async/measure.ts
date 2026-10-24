// R2 (FORG-36) evidence and measurements: which async mechanisms work for a WASM unit's capability
// calls at the pinned versions, and what a capability call costs through the chosen one (JSPI)
// against the JS unit. Everything runs on this machine: workerd through Miniflare, and Node.
//
//   cargo build -p forgegraph-cli && node research/composable-units/r2-wasm-async/measure.ts
//
// The component-model-async (P3) variant is built from impl/price-cart-rs in a temporary
// directory, with `async` added to the WIT and wit-bindgen's `async` feature. It needs the pinned
// Rust toolchain and wasm-tools; without them it is recorded as missing.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { bindUnit, CALLER, D1_RESOURCE_HOST, D1_RESOURCE_HOST_SCHEMA, transpiledModules, type BoundUnit, type WorkerModule } from "../../../packages/units/src/harness.ts";
import { seal, type UnitPlan } from "../../../packages/units/src/seal.ts";
import { TRANSPILER, transpileComponent } from "../../../packages/units/src/wasm.ts";
import { asyncImports, type Lowering } from "../../../packages/units/src/wit-lowering.ts";
import type { PriceCartInput, Product } from "../../../examples/pricing/impl/cart.ts";
import { TOOLCHAIN } from "../../../examples/pricing/build-component.mjs";

const root = resolve(import.meta.dirname, "../../..");
const units = createRequire(join(root, "packages/units/package.json"));
const { build } = units("esbuild") as typeof import("esbuild");
const { Miniflare } = units("miniflare") as typeof import("miniflare");
type Miniflare = InstanceType<typeof Miniflare>;
const pricing = join(root, "examples/pricing");
const SYMBOL = "@acme/pricing/_/PriceCart";
const PRODUCT = "@acme/pricing/_/Product";
const CAPABILITY = `resource:${PRODUCT}#read`;
const COMPAT = "2026-07-01";
const REPEATS = 7;

const size = (b: Uint8Array) => ({ raw: b.byteLength, gzip: gzipSync(b, { level: 9 }).byteLength });
const sum = (xs: Array<{ raw: number; gzip: number }>) => ({ raw: xs.reduce((a, x) => a + x.raw, 0), gzip: xs.reduce((a, x) => a + x.gzip, 0) });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number, d = 3) => Number(x.toFixed(d));
const enc = (s: string) => new TextEncoder().encode(s);
const scratch: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  scratch.push(d);
  return d;
};
const missing: string[] = [
  "Deployed Cloudflare Workers: whether production isolates expose JSPI as local workerd does, cold start, CPU time per call and isolate memory. Not measured; everything here is local.",
  "Stack memory per suspended call (JSPI allocates a secondary stack per promising() call): not measured.",
];

async function worker<T>(modules: WorkerModule[], f: (mf: Miniflare) => Promise<T>, options: { d1?: boolean; flags?: string[]; date?: string } = {}): Promise<T> {
  const mf = new Miniflare({ modules, compatibilityDate: options.date ?? COMPAT, compatibilityFlags: options.flags ?? [], ...(options.d1 ? { d1Databases: ["DB"] } : {}) });
  try {
    if (options.d1) {
      const db = await mf.getD1Database("DB");
      await db.exec(D1_RESOURCE_HOST_SCHEMA);
      await db.batch(CATALOG.map((p) => db.prepare("INSERT INTO forge_harness_records (resource, id, body) VALUES (?, ?, ?)").bind(PRODUCT, p.id, JSON.stringify(p))));
    }
    return await f(mf);
  } finally {
    await mf.dispose();
  }
}
const post = async (mf: Miniflare, path: string, body: unknown) => {
  const res = await mf.dispatchFetch(`http://unit${path}`, { method: "POST", body: JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
};
const esm = (path: string, contents: string | Uint8Array): WorkerModule => ({ type: "ESModule", path, contents: typeof contents === "string" ? enc(contents) : contents });
const wasmModule = (path: string, contents: Uint8Array): WorkerModule => ({ type: "CompiledWasm", path, contents });

// ------------------------------------------------------------------ 1. what the platform supports

// (module (import "host" "get" (func (param i32) (result i32)))
//   (func (export "run") (param i32) (result i32) (i32.add (call 0 (local.get 0)) (i32.const 1))))
const PROBE_WASM = Buffer.from("0061736d0100000001060160017f017f020c0104686f7374036765740000030201000707010372756e00010a0b0109002000100041016a0b", "hex");
const JSPI_PROBE = `import mod from "./probe.wasm";
export default { async fetch() {
  const out = { Suspending: typeof WebAssembly.Suspending, promising: typeof WebAssembly.promising };
  try {
    // A real suspension: the import awaits a timer before the WASM stack resumes.
    const get = new WebAssembly.Suspending(async (x) => { await scheduler.wait(1); return x * 2; });
    const run = WebAssembly.promising((await WebAssembly.instantiate(mod, { host: { get } })).exports.run);
    out.result = await run(20);
  } catch (e) { out.error = String(e); }
  return Response.json(out);
}};`;
const jspiInWorkerd: Array<Record<string, unknown>> = [];
for (const [date, flags] of [[COMPAT, []], [COMPAT, ["nodejs_compat"]], [COMPAT, ["experimental"]], ["2024-01-01", []]] as const) {
  const r = await worker([esm("w.js", JSPI_PROBE), wasmModule("probe.wasm", PROBE_WASM)], async (mf) => (await (await mf.dispatchFetch("http://unit/")).json()) as Record<string, unknown>, { date, flags: [...flags] });
  jspiInWorkerd.push({ compatibilityDate: date, flags, ...r, works: r["result"] === 41 });
}
const nodeProbe = (flags: string[]) => {
  const src = `const m = await WebAssembly.compile(Buffer.from(${JSON.stringify(PROBE_WASM.toString("hex"))}, "hex"));
try { const get = new WebAssembly.Suspending(async (x) => x * 2); const run = WebAssembly.promising((await WebAssembly.instantiate(m, { host: { get } })).exports.run); console.log(JSON.stringify({ result: await run(20) })); }
catch (e) { console.log(JSON.stringify({ error: String(e) })); }`;
  const out = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", src], { encoding: "utf8" });
  return { flags, v8: process.versions.v8, ...(JSON.parse(out.stdout.trim() || `{"error":${JSON.stringify(out.stderr.trim())}}`) as object) };
};
const jspiInNode = [nodeProbe([]), nodeProbe(["--experimental-wasm-jspi"])];

// ------------------------------------------------------------------ the unit, sealed both ways

const planDir = tmp("r2-plan-");
execFileSync(join(root, "target/debug/forgec"), ["build", pricing, "--units", "--out", planDir], { stdio: "pipe" });
const plan = JSON.parse(readFileSync(join(planDir, "units/plan.json"), "utf8")) as UnitPlan;
const js = await seal(plan, pricing);
const wasm = await seal(plan, pricing, { components: { [SYMBOL]: "impl/price-cart.wasm" } });
const wasmUnit = wasm.manifest.units[wasm.bySymbol.get(SYMBOL)!]!;
const jsUnit = js.manifest.units[js.bySymbol.get(SYMBOL)!]!;
const component = wasm.modules.get(wasmUnit.implementation["component"] as string)!;
const loweringText = new TextDecoder().decode(wasm.modules.get(wasmUnit.implementation["lowering"] as string)!);
const lowering = JSON.parse(loweringText) as Lowering;

// The catalog every host serves, and carts by size.
const CATALOG: Product[] = Array.from({ length: 100 }, (_, i) => ({ id: `p-${i}`, sku: `SKU-${String(i).padStart(4, "0")}`, unitPrice: `${(i * 37) % 500}.${String((i * 13) % 100).padStart(2, "0")}`, active: true }));
const cart = (items: number): PriceCartInput => ({ items: Array.from({ length: items }, (_, i) => ({ product: `p-${i % CATALOG.length}`, quantity: (i % 9) + 1 })) });
const CARTS = [1, 10, 100];

/** Resolves reads from an in-isolate Map: a capability call with no I/O, so the mechanism is all that is timed. */
const MEMORY_HOST = `const CATALOG = new Map(${JSON.stringify(CATALOG.map((p) => [p.id, p]))});
export function capability(name) {
  if (name !== ${JSON.stringify(CAPABILITY)}) return null;
  return {
    async get(id) {
      const v = CATALOG.get(id);
      return v ? { ok: true, value: v } : { ok: false, code: "NotFound", detail: "Product " + id + " does not exist" };
    },
  };
}
`;
const HOSTS = { memory: MEMORY_HOST, d1: D1_RESOURCE_HOST };

// ------------------------------------------------------------------ the variants

const withHost = (b: BoundUnit, host: string): BoundUnit => ({ ...b, modules: b.modules.map((m) => (m.path === "host.js" ? esm("host.js", host) : m)) });
const boundWasm = await bindUnit(wasm, SYMBOL, pricing, { host: MEMORY_HOST });
const boundJs = await bindUnit(js, SYMBOL, pricing, { host: MEMORY_HOST });
const callerModule = boundJs.modules.find((m) => m.path === "caller.js")!;

// Prefetch: the same component transpiled without JSPI (synchronous imports). Before the call the
// host resolves every read the cart will make, concurrently, and the import answers from that
// cache. The read plan (`items[].product`) is written by hand: nothing in the declaration says
// which input paths a read uses (`CartItem.product` is an `id`, not a reference).
const syncT = await transpileComponent(component);
const syncCores = Object.keys(syncT.core).sort();
const prefetchBound = await build({
  stdin: {
    contents: `import { instantiate } from "./unit.js";
import { capability } from "./host.js";
import { bindExport, lower } from ${JSON.stringify(join(root, "packages/units/src/wit-lowering.ts"))};
${syncCores.map((n, i) => `import core${i} from "./${n}";`).join("\n")}
const cores = { ${syncCores.map((n, i) => `"${n}": core${i}`).join(", ")} };
const lowering = ${loweringText.trim()};
const record = lowering.imports[0].functions[0].result;
const cache = new Map();
const fail = (payload) => Object.assign(new Error("capability failed"), { payload });
const get = (id) => {
  const r = cache.get(id);
  if (!r) throw fail({ code: "NotPrefetched", detail: id });
  if (!r.ok) throw fail({ code: r.code, detail: r.detail });
  return lower(lowering, record, r.value);
};
let bound, handle;
export async function ready() {
  handle ??= capability(${JSON.stringify(CAPABILITY)});
  bound ??= bindExport(lowering, await instantiate((n) => cores[n], { "forge:unit/resource-product-read": { get } }));
}
export async function invoke(input) {
  if (!bound) await ready();
  const ids = [...new Set(input.items.map((i) => i.product))];
  const reads = await Promise.all(ids.map((id) => handle.get(id)));
  cache.clear();
  ids.forEach((id, k) => cache.set(id, reads[k]));
  return bound(input);
}
`,
    resolveDir: root,
    loader: "js",
    sourcefile: "bound.js",
  },
  bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", external: ["./unit.js", "./host.js", "*.wasm"], logLevel: "silent",
});
const boundPrefetch: BoundUnit = {
  kind: "wasm-prefetch",
  modules: [callerModule, esm("bound.js", prefetchBound.outputFiles[0]!.contents), esm("host.js", MEMORY_HOST), esm("unit.js", syncT.glue), ...syncCores.map((n) => wasmModule(n, syncT.core[n]!))],
};

// The floor: the cart logic as a plain async function awaiting the same handle, no unit ABI, no Effect.
const plainBound = await build({
  stdin: {
    contents: `import { cents, checked, money, Overflow } from "./impl/quote.ts";
import { capability } from "./host.js";
let h;
export async function ready() {}
export async function invoke(input) {
  h ??= capability(${JSON.stringify(CAPABILITY)});
  if (input.items.length === 0) return { ok: false, code: "EmptyCart", detail: "a cart needs at least one item" };
  const lines = [];
  let subtotal = 0n;
  for (const item of input.items) {
    const r = await h.get(item.product);
    if (!r.ok) return r;
    const p = r.value;
    if (!p.active) return { ok: false, code: "InactiveProduct", detail: "product " + p.sku + " is not active" };
    let amount;
    try { amount = checked(BigInt(item.quantity) * cents(p.unitPrice)); subtotal = checked(subtotal + amount); }
    catch (e) { if (e instanceof Overflow) return { ok: false, code: "CartTooLarge", detail: "line totals overflow" }; throw e; }
    lines.push({ sku: p.sku, quantity: item.quantity, amount: money(amount) });
  }
  return { ok: true, value: { lines, subtotal: money(subtotal) } };
}
`,
    resolveDir: pricing,
    loader: "js",
    sourcefile: "bound.js",
  },
  bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", external: ["./host.js"], logLevel: "silent",
});
const boundPlain: BoundUnit = { kind: "plain-js-async-function", modules: [callerModule, esm("bound.js", plainBound.outputFiles[0]!.contents), esm("host.js", MEMORY_HOST)] };

// Component-model async (WASI P3): `async func` in the WIT, wit-bindgen's async runtime in the guest.
const p3: { component?: Uint8Array; bound?: BoundUnit; glue?: { raw: number; gzip: number }; core?: { raw: number; gzip: number }; coreModules?: string[]; error?: string } = {};
try {
  const dir = tmp("r2-p3-");
  cpSync(join(pricing, "impl/price-cart-rs"), dir, { recursive: true });
  const edit = (f: string, pairs: Array<[string | RegExp, string]>) => {
    let s = readFileSync(join(dir, f), "utf8");
    for (const [a, b] of pairs) {
      const next = s.replace(a, b);
      if (next === s) throw new Error(`P3 variant: ${String(a)} not found in ${f}`);
      s = next;
    }
    writeFileSync(join(dir, f), s);
  };
  edit("Cargo.toml", [['features = ["macros", "realloc"]', 'features = ["macros", "realloc", "async"]']]);
  edit("wit/unit.wit", [["  get: func(id: string)", "  get: async func(id: string)"], ["  export run: func(", "  export run: async func("]]);
  edit("src/lib.rs", [
    ["    fn run(input: PriceCartInput) -> Result<CartPrice, Failure> {\n        price(input)", "    async fn run(input: PriceCartInput) -> Result<CartPrice, Failure> {\n        price(input).await"],
    ["\nfn price(", "\nasync fn price("],
    ["products::get(&item.product)", "products::get(item.product.clone()).await"],
  ]);
  const target = join(dir, "target");
  execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", target], { cwd: dir, stdio: "pipe" });
  const out = join(dir, "p3.wasm");
  execFileSync("wasm-tools", ["component", "new", join(target, "wasm32-unknown-unknown/release/price_cart.wasm"), "-o", out], { stdio: "pipe" });
  p3.component = new Uint8Array(readFileSync(out));
  const t = await transpileComponent(p3.component);
  const [bound, ...glue] = await transpiledModules(t, loweringText);
  p3.bound = { kind: "wasm-p3-async", modules: [callerModule, bound!, esm("host.js", MEMORY_HOST), ...glue] };
  p3.glue = size(t.glue);
  p3.core = sum(Object.values(t.core).map(size));
  p3.coreModules = Object.keys(t.core).sort();
} catch (e) {
  p3.error = String((e as Error).message ?? e).slice(0, 400);
  missing.push(`Component-model async (P3) variant: not built here (${p3.error}).`);
}

// ------------------------------------------------------------------ 2. correctness of every variant

const correctness: Record<string, unknown> = {};
{
  const probe = [cart(3), { items: [] }, { items: [{ product: "nope", quantity: 1 }] }];
  const expected = await worker(boundJs.modules, async (mf) => post(mf, "/batch", probe) as unknown as Promise<unknown[]>);
  for (const b of [boundWasm, boundPrefetch, boundPlain, ...(p3.bound ? [p3.bound] : [])]) {
    const got = await worker(b.modules, async (mf) => post(mf, "/batch", probe) as unknown as Promise<unknown[]>);
    correctness[b.kind] = { sameAsJsModule: JSON.stringify(got) === JSON.stringify(expected), outcomes: (got as Array<{ ok: boolean; code?: string }>).map((r) => (r.ok ? "ok" : r.code)) };
  }
}

// ------------------------------------------------------------------ 3. per-call cost in workerd

const readings: number[] = [];
const bench = async (b: BoundUnit, input: PriceCartInput, n: number, d1: boolean) =>
  worker(
    b.modules,
    async (mf) => {
      await post(mf, "/bench", { input, n: Math.ceil(n / 10) }); // warm up
      const samples: number[] = [];
      for (let i = 0; i < (d1 ? 5 : REPEATS); i++) {
        const { ms, ok } = (await post(mf, "/bench", { input, n })) as { ms: number; ok: boolean };
        if (!ok) throw new Error(`${b.kind}: the benchmark call failed`);
        readings.push(ms);
        samples.push((ms * 1e6) / n);
      }
      return { nsPerCallMedian: round(median(samples), 0), samplesNsPerCall: samples.map((s) => round(s, 0)) };
    },
    { d1 },
  );

const perCall: Record<string, Record<string, unknown>> = {};
for (const [hostName, host] of Object.entries(HOSTS)) {
  const d1 = hostName === "d1";
  const variants = [boundWasm, boundJs, boundPrefetch, boundPlain, ...(p3.bound ? [p3.bound] : [])].map((b) => withHost(b, host));
  const rows: Record<string, unknown> = {};
  const medians: Record<string, Record<number, number>> = {};
  for (const items of CARTS) {
    const base = d1 ? Math.max(10, Math.round(1_500 / items)) : Math.max(200, Math.round(60_000 / items));
    // The P3 glue polls with setTimeout (about 1 ms per capability call here): fewer iterations.
    const iterations = (b: BoundUnit) => (b.kind === "wasm-p3-async" ? Math.max(5, Math.round(base / (d1 ? 2 : 100))) : base);
    const row: Record<string, unknown> = { capabilityCallsPerInvocation: items, iterations: base, ...(p3.bound ? { p3Iterations: iterations(p3.bound) } : {}) };
    for (const b of variants) {
      console.error(`perCall ${hostName} ${items} item(s) ${b.kind}`);
      const r = await bench(b, cart(items), iterations(b), d1);
      row[b.kind] = r;
      (medians[b.kind] ??= {})[items] = r.nsPerCallMedian;
    }
    const w = medians["wasm-component"]![items]!;
    row["wasmJspiOverJsModule"] = round(w / medians["js-module"]![items]!, 2);
    rows[`${items} item(s)`] = row;
  }
  // The marginal cost of one more item, between the 10- and 100-item carts: one capability call
  // plus that item's marshalling and arithmetic.
  const marginal = Object.fromEntries(Object.entries(medians).map(([k, m]) => [k, round((m[100]! - m[10]!) / 90, 0)]));
  perCall[hostName] = { ...rows, marginalNsPerItem: marginal };
}

// The raw JSPI suspend/resume, without jco: the probe module, one import call per run().
const RAW = `import mod from "./probe.wasm";
const sync = (await WebAssembly.instantiate(mod, { host: { get: (x) => x * 2 } })).exports.run;
const suspending = WebAssembly.promising((await WebAssembly.instantiate(mod, { host: { get: new WebAssembly.Suspending(async (x) => x * 2) } })).exports.run);
const promisingOnly = WebAssembly.promising(sync);
const asyncJs = async (x) => (await (async (y) => y * 2)(x)) + 1;
const variants = { syncImport: async (x) => sync(x), promisingNoSuspend: (x) => promisingOnly(x), suspendingImport: (x) => suspending(x), asyncJsFunction: asyncJs };
export default { async fetch(req) {
  const { variant, n } = await req.json();
  const f = variants[variant];
  for (let i = 0; i < n / 10; i++) await f(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await f(i);
  return Response.json({ ms: performance.now() - t0 });
}};`;
const rawJspi: Record<string, unknown> = { note: "One WASM->JS import call per awaited run(). suspendingImport is the JSPI round trip: promising() entry, a secondary stack, suspend on the import's promise, resume. promisingNoSuspend enters through promising() with a synchronous import. syncImport awaits a plain synchronous call, the floor." };
await worker([esm("w.js", RAW), wasmModule("probe.wasm", PROBE_WASM)], async (mf) => {
  for (const variant of ["syncImport", "promisingNoSuspend", "suspendingImport", "asyncJsFunction"]) {
    const n = 200_000;
    const samples: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      const { ms } = (await (await mf.dispatchFetch("http://unit/", { method: "POST", body: JSON.stringify({ variant, n }) })).json()) as { ms: number };
      readings.push(ms);
      samples.push((ms * 1e6) / n);
    }
    rawJspi[variant] = { nsPerCallMedian: round(median(samples), 0), samplesNsPerCall: samples.map((s) => round(s, 0)) };
  }
});

// ------------------------------------------------------------------ 4. concurrency on one instance

// Two invocations at once, each reading 5 products with a 5 ms wait per read. The JSPI component is
// one instance with one linear memory and stack: jco's task lock serializes the second call behind
// the first. The JS unit interleaves them.
const SLOW_HOST = `export const log = [];
export function capability(name) {
  return { async get(id) { log.push(id); await scheduler.wait(5); return { ok: true, value: { id, sku: id.toUpperCase(), unitPrice: "1.00", active: true } }; } };
}
`;
const CONCURRENT_CALLER = `import { invoke, ready } from "./bound.js";
import { log } from "./host.js";
export default { async fetch() {
  await ready();
  const a = { items: ["a1", "a2", "a3", "a4", "a5"].map((product) => ({ product, quantity: 1 })) };
  const b = { items: ["b1", "b2", "b3", "b4", "b5"].map((product) => ({ product, quantity: 1 })) };
  log.length = 0;
  let t0 = performance.now();
  await invoke(a);
  const one = performance.now() - t0;
  log.length = 0;
  t0 = performance.now();
  const both = await Promise.all([invoke(a), invoke(b)]);
  return Response.json({ oneMs: one, twoConcurrentMs: performance.now() - t0, readOrder: [...log], bothOk: both.every((r) => r.ok) });
}};`;
const concurrency: Record<string, unknown> = { note: "Two concurrent invocations on one isolate, 5 reads each, 5 ms per read (scheduler.wait)." };
for (const b of [boundWasm, boundJs]) {
  const modules = b.modules.map((m) => (m.path === "caller.js" ? esm("caller.js", CONCURRENT_CALLER) : m.path === "host.js" ? esm("host.js", SLOW_HOST) : m));
  concurrency[b.kind] = await worker(modules, async (mf) => (await (await mf.dispatchFetch("http://unit/")).json()) as unknown);
}

// ------------------------------------------------------------------ 5. sizes

const jspiT = await transpileComponent(component, { asyncImports: asyncImports(lowering) });
const glueSizes = (t: { glue: Uint8Array; core: Record<string, Uint8Array> }) => ({ glue: size(t.glue), core: sum(Object.values(t.core).map(size)), coreModules: Object.keys(t.core).sort(), total: sum([size(t.glue), ...Object.values(t.core).map(size)]) });
let asyncify: Record<string, unknown>;
try {
  // binaryen is jco's dependency: resolve it from jco's real (pnpm store) directory.
  const jco = createRequire(realpathSync(join(root, "packages/units/node_modules/@bytecodealliance/jco/package.json")));
  const binaryen = dirname(jco.resolve("binaryen"));
  const wasmOpt = [join(binaryen, "bin/wasm-opt"), join(binaryen, "../bin/wasm-opt")].find(existsSync);
  if (!wasmOpt) throw new Error("binaryen's wasm-opt is not installed");
  const dir = tmp("r2-asyncify-");
  writeFileSync(join(dir, "core.wasm"), syncT.core["unit.core.wasm"]!);
  const opt = (out: string, extra: string[]) => {
    execFileSync(process.execPath, [wasmOpt, join(dir, "core.wasm"), "--all-features", ...extra, "-O2", "-o", join(dir, out)], { stdio: "pipe" });
    return size(readFileSync(join(dir, out)));
  };
  const version = execFileSync(process.execPath, [wasmOpt, "--version"], { encoding: "utf8" }).trim();
  const o2 = opt("o2.wasm", []);
  const withAsyncify = opt("asyncify.wasm", ["--asyncify", "--pass-arg=asyncify-imports@forge:unit/resource-product-read.get"]);
  asyncify = { wasmOpt: version, coreAsTranspiled: size(syncT.core["unit.core.wasm"]!), coreO2: o2, coreAsyncifyO2: withAsyncify, growthOverO2: round(withAsyncify.raw / o2.raw - 1, 3), note: "Size only. jco has no asyncify mode, so running it needs hand-written glue that unwinds and rewinds around jco's lowering of each import; not built." };
} catch (e) {
  asyncify = { error: String((e as Error).message ?? e).slice(0, 300) };
  missing.push("Asyncify size: binaryen's wasm-opt was not available.");
}
const sizes = {
  component: size(component),
  transpiled: { "sync (no imports wired; prefetch)": glueSizes(syncT), "jspi (the harness setting)": glueSizes(jspiT), ...(p3.component ? { "p3 component-model async": { component: size(p3.component), glue: p3.glue, core: p3.core, coreModules: p3.coreModules } } : {}) },
  workerModules: Object.fromEntries([boundWasm, boundJs].map((b) => [b.kind, { modules: Object.fromEntries(b.modules.map((m) => [m.path, size(m.contents)])), total: sum(b.modules.map((m) => size(m.contents))) }])),
  asyncify,
  notes: ["Glue sizes are minified, as the harness ships them. The JSPI glue adds two tiny core modules (jco's import trampolines) to the unit's own."],
};

const pkgVersion = (p: string) => (JSON.parse(readFileSync(join(root, "packages/units/node_modules", p, "package.json"), "utf8")) as { version: string }).version;
const results = {
  version: "r2-results/1",
  label: "local",
  measuredOn: { node: process.version, platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model ?? "unknown", workerd: `miniflare@${pkgVersion("miniflare")} (bundled workerd)`, transpiler: TRANSPILER, component: TOOLCHAIN, compatibilityDate: COMPAT },
  unit: { symbol: SYMBOL, capability: CAPABILITY, interfaceHash: wasmUnit.interfaceHash, sameInterfaceHash: wasmUnit.interfaceHash === jsUnit.interfaceHash, implementationHash: { "wasm-component": wasmUnit.implementationHash, "js-module": jsUnit.implementationHash }, world: wasmUnit.implementation["world"] },
  support: { jspiInWorkerd, jspiInNode, note: "jspiInWorkerd runs a real suspension (an awaited timer inside the import) under each compatibility date and flag set." },
  correctness,
  perCall: { clockReadingsAllWholeMs: readings.every(Number.isInteger), minReadingMs: Math.min(...readings), note: "workerd, median of runs of n awaited invocations inside one request (7 runs, 5 for D1). Times are per invocation; an invocation of an N-item cart makes N capability calls (prefetch: N reads before the call). memory: the handle resolves from an in-isolate Map, no I/O. d1: the harness's D1 resource store (local workerd D1).", ...perCall, rawJspi },
  concurrency,
  p3: p3.bound
    ? { built: true, note: "jco 1.39 runs component-model async tasks from a tick loop scheduled with setTimeout (0 ms after a task resumes, 10 ms when idle), and its host-import path still uses WebAssembly.Suspending: P3 here needs JSPI too, and pays a timer per capability call." }
    : { built: false, error: p3.error },
  sizes,
  missing,
  caller: { bytes: enc(CALLER).byteLength },
};
writeFileSync(join(import.meta.dirname, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(JSON.stringify({ support: results.support, correctness, perCall, concurrency, sizes: { component: sizes.component, transpiled: sizes.transpiled, asyncify } }, null, 2));
