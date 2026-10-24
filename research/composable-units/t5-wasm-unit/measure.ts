// T5 (FORG-31) measurements: sizes before and after transpile, per-call cost of the JS<->WASM
// boundary against the JS implementation at several payload sizes, and instantiation time.
// Everything here runs on this machine: workerd through Miniflare, and Node for a breakdown.
//
//   cargo build -p forgegraph-cli && node research/composable-units/t5-wasm-unit/measure.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { bindExport, type Lowering } from "../../../packages/units/src/wit-lowering.ts";
import { bindUnit, CALLER, type BoundUnit } from "../../../packages/units/src/harness.ts";
import { seal, type UnitPlan } from "../../../packages/units/src/seal.ts";
import { TRANSPILER, transpileComponent } from "../../../packages/units/src/wasm.ts";
import { quote, type QuoteOrderInput } from "../../../examples/pricing/impl/quote.ts";
import { TOOLCHAIN } from "../../../examples/pricing/build-component.mjs";

const root = resolve(import.meta.dirname, "../../..");
// Tools resolve from @forgegraph/units, which pins them.
const units = createRequire(join(root, "packages/units/package.json"));
const { build } = units("esbuild") as typeof import("esbuild");
const { Miniflare } = units("miniflare") as typeof import("miniflare");
type Miniflare = InstanceType<typeof Miniflare>;
const pricing = join(root, "examples/pricing");
const SYMBOL = "@acme/pricing/_/QuoteOrder";
const COMPAT = "2026-07-01";
const REPEATS = 7;

const size = (b: Uint8Array) => ({ raw: b.byteLength, gzip: gzipSync(b, { level: 9 }).byteLength });
const sum = (xs: Array<{ raw: number; gzip: number }>) => ({ raw: xs.reduce((a, x) => a + x.raw, 0), gzip: xs.reduce((a, x) => a + x.gzip, 0) });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number, d = 3) => Number(x.toFixed(d));

const tmp = mkdtempSync(join(tmpdir(), "t5-measure-"));
execFileSync(join(root, "target/debug/forgec"), ["build", pricing, "--units", "--out", tmp], { stdio: "pipe" });
const plan = JSON.parse(readFileSync(join(tmp, "units/plan.json"), "utf8")) as UnitPlan;
rmSync(tmp, { recursive: true, force: true });
const js = await seal(plan, pricing);
const wasm = await seal(plan, pricing, { components: { [SYMBOL]: "impl/quote-order.wasm" } });
const wasmUnit = wasm.manifest.units[wasm.bySymbol.get(SYMBOL)!]!;
const jsUnit = js.manifest.units[js.bySymbol.get(SYMBOL)!]!;
const component = wasm.modules.get(wasmUnit.implementation["component"] as string)!;
const lowering = JSON.parse(new TextDecoder().decode(wasm.modules.get(wasmUnit.implementation["lowering"] as string)!)) as Lowering;

// ------------------------------------------------------------------ sizes

const transpiled: Record<string, unknown> = {};
for (const [name, opts] of [
  ["default (linker setting: minified glue)", { minify: true }],
  ["unminified glue", { minify: false }],
  ["minified glue + wasm-opt", { minify: true, optimize: true }],
] as const) {
  const t = await transpileComponent(component, opts);
  const core = sum(Object.values(t.core).map(size));
  const glue = size(t.glue);
  transpiled[name] = { glue, core, total: sum([glue, core]), coreModules: Object.keys(t.core) };
}
const boundWasm = await bindUnit(wasm, SYMBOL, pricing);
const boundJs = await bindUnit(js, SYMBOL, pricing);
const workerBytes = (b: BoundUnit) => Object.fromEntries(b.modules.map((m) => [m.path, size(m.contents)]));
const sizes = {
  component: size(component),
  transpiled,
  workerModules: { "wasm-component": { modules: workerBytes(boundWasm), total: sum(boundWasm.modules.map((m) => size(m.contents))) }, "js-module": { modules: workerBytes(boundJs), total: sum(boundJs.modules.map((m) => size(m.contents))) } },
  jsUnitModule: size(js.modules.get(jsUnit.implementation["module"] as string)!),
  lowering: size(wasm.modules.get(wasmUnit.implementation["lowering"] as string)!),
  notes: [
    "component: impl/quote-order.wasm as sealed (wasm32-unknown-unknown, opt-level s, LTO, panic=abort, stripped, no wasm-opt).",
    "workerModules: what the harness linker uploads per variant. The js-module variant carries Effect (a shared library a real host would load once for all units); its unit module alone is jsUnitModule.",
  ],
};

// ------------------------------------------------------------------ inputs by payload size

const input = (lines: number): QuoteOrderInput => ({
  lines: Array.from({ length: lines }, (_, i) => ({ sku: `SKU-${String(i).padStart(5, "0")}`, quantity: (i % 9) + 1, unitPrice: `${(i * 37) % 5000}.${String((i * 13) % 100).padStart(2, "0")}` })),
  tier: "gold",
  taxRateBasisPoints: 825,
  shipping: "12.50",
});
const PAYLOADS = [1, 10, 100, 1000];
const iterations = (lines: number) => Math.max(200, Math.round(200_000 / lines));

// A third variant: the bare TS function, no unit ABI and no Effect, as the floor.
const plainBound = (await build({
  stdin: { contents: `import { quote } from "./impl/quote.ts";\nexport async function ready() {}\nexport async function invoke(input) { const r = quote(input); return r.ok ? { ok: true, value: r.value } : r; }\n`, resolveDir: pricing, loader: "js", sourcefile: "bound.js" },
  bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent",
})).outputFiles[0]!.contents;
const boundPlain: BoundUnit = { kind: "plain-js-function", modules: [boundJs.modules[0]!, { type: "ESModule", path: "bound.js", contents: plainBound }] };

async function withWorker<T>(b: BoundUnit, f: (mf: Miniflare) => Promise<T>): Promise<T> {
  const mf = new Miniflare({ modules: b.modules, compatibilityDate: COMPAT });
  try {
    return await f(mf);
  } finally {
    await mf.dispose();
  }
}
const post = async (mf: Miniflare, path: string, body: unknown) => (await (await mf.dispatchFetch(`http://unit${path}`, { method: "POST", body: JSON.stringify(body) })).json()) as { ms: number; ok: boolean };

// Every in-Worker clock reading, to report its granularity alongside the per-call numbers.
const readings: number[] = [];

const workerd: Record<string, unknown> = {};
for (const lines of PAYLOADS) {
  const payload = input(lines);
  const n = iterations(lines);
  const row: Record<string, unknown> = { payloadBytes: new TextEncoder().encode(JSON.stringify(payload)).byteLength, iterations: n };
  for (const b of [boundWasm, boundJs, boundPlain]) {
    row[b.kind] = await withWorker(b, async (mf) => {
      await post(mf, "/bench", { input: payload, n: Math.ceil(n / 10) }); // warm up
      const samples: number[] = [];
      for (let i = 0; i < REPEATS; i++) {
        const { ms } = await post(mf, "/bench", { input: payload, n });
        readings.push(ms);
        samples.push((ms * 1e6) / n);
      }
      return { nsPerCallMedian: round(median(samples), 0), samplesNsPerCall: samples.map((s) => round(s, 0)) };
    });
  }
  const w = (row["wasm-component"] as { nsPerCallMedian: number }).nsPerCallMedian;
  row["wasmOverJsModule"] = round(w / (row["js-module"] as { nsPerCallMedian: number }).nsPerCallMedian, 2);
  row["wasmOverPlainJs"] = round(w / (row["plain-js-function"] as { nsPerCallMedian: number }).nsPerCallMedian, 2);
  workerd[`${lines} line(s)`] = row;
}

// ------------------------------------------------------------------ Node breakdown (same V8 family)

const t = await transpileComponent(component, { minify: true });
const again = await transpileComponent(component, { minify: true });
const transpileDeterministic = Buffer.compare(t.glue, again.glue) === 0 && Object.keys(t.core).every((k) => Buffer.compare(t.core[k]!, again.core[k]!) === 0);
const dir = mkdtempSync(join(tmpdir(), "t5-glue-"));
writeFileSync(join(dir, "unit.mjs"), t.glue);
const { instantiate } = (await import(join(dir, "unit.mjs"))) as { instantiate: (get: (n: string) => WebAssembly.Module, imports: object) => Promise<Record<string, (...a: unknown[]) => unknown>> };
const coreBytes = t.core["unit.core.wasm"]!;
const compileSamples: number[] = [];
let mod!: WebAssembly.Module;
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  mod = await WebAssembly.compile(coreBytes);
  compileSamples.push(performance.now() - t0);
}
const instSamples: number[] = [];
const firstCallSamples: number[] = [];
for (let i = 0; i < 50; i++) {
  const t0 = performance.now();
  const exports = await instantiate(() => mod, {});
  const t1 = performance.now();
  bindExport(lowering, exports)(input(1));
  firstCallSamples.push(performance.now() - t1);
  instSamples.push(t1 - t0);
}
const exportsNode = await instantiate(() => mod, {});
const call = bindExport(lowering, exportsNode);
const lowerOnly = (x: QuoteOrderInput) => ({ lines: x.lines.map((l) => ({ sku: l.sku, quantity: BigInt(l.quantity), unitPrice: l.unitPrice })), tier: x.tier, taxRateBasisPoints: BigInt(x.taxRateBasisPoints), shipping: x.shipping ?? undefined });
function perCall(f: () => unknown, n: number): number {
  for (let i = 0; i < Math.ceil(n / 10); i++) f();
  const s: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) f();
    s.push(((performance.now() - t0) * 1e6) / n);
  }
  return round(median(s), 0);
}
const node: Record<string, unknown> = {};
for (const lines of PAYLOADS) {
  const payload = input(lines);
  const lowered = lowerOnly(payload);
  const n = iterations(lines);
  const full = perCall(() => call(payload), n);
  const glueOnly = perCall(() => exportsNode["run"]!(lowered), n);
  const plain = perCall(() => quote(payload), n);
  node[`${lines} line(s)`] = { iterations: n, wasmUnitNs: full, jcoGlueAndWasmNs: glueOnly, loweringAdapterNs: full - glueOnly, plainJsNs: plain, wasmOverPlainJs: round(full / plain, 2) };
}
// Probe: the glue's `_debugLog` reads globalThis.process.env.JCO_DEBUG on every step of a call.
// Node's process.env is a slow host getter; this measures the glue with that read removed.
writeFileSync(join(dir, "unit-nodebug.mjs"), new TextDecoder().decode(t.glue).replace(/globalThis\??\.process\??\.env\??\.JCO_DEBUG/g, "false"));
const noDebug = (await import(join(dir, "unit-nodebug.mjs"))) as { instantiate: typeof instantiate };
const exportsNoDebug = await noDebug.instantiate(() => mod, {});
const one = lowerOnly(input(1));
const debugLogProbe = {
  note: "Glue + WASM only, 1 line, in Node: as shipped vs with the per-step JCO_DEBUG env read replaced by `false`. workerd without nodejs_compat has no process, so it does not pay this.",
  asShippedNs: perCall(() => exportsNode["run"]!(one), 200_000),
  envReadRemovedNs: perCall(() => exportsNoDebug["run"]!(one), 200_000),
};
rmSync(dir, { recursive: true, force: true });

// Instantiation in workerd: a fresh isolate per sample, timing the first `ready()` inside it.
const workerdInstantiation: number[] = [];
for (let i = 0; i < 10; i++) workerdInstantiation.push(await withWorker(boundWasm, async (mf) => (await post(mf, "/ready", null)).ms));
const workerdFirstCall: Record<string, number[]> = {};
for (const b of [boundWasm, boundJs]) {
  workerdFirstCall[b.kind] = [];
  for (let i = 0; i < 5; i++) workerdFirstCall[b.kind]!.push(await withWorker(b, async (mf) => (await post(mf, "/bench", { input: input(1), n: 1 })).ms));
}

const pkgVersion = (p: string) => (JSON.parse(readFileSync(join(root, "packages/units/node_modules", p, "package.json"), "utf8")) as { version: string }).version;
const results = {
  version: "t5-results/1",
  label: "local",
  measuredOn: { node: process.version, platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model ?? "unknown", workerd: `miniflare@${pkgVersion("miniflare")} (bundled workerd)`, transpiler: TRANSPILER, component: TOOLCHAIN, compatibilityDate: COMPAT },
  unit: { symbol: SYMBOL, interfaceHash: wasmUnit.interfaceHash, unitHash: { "wasm-component": wasm.bySymbol.get(SYMBOL), "js-module": js.bySymbol.get(SYMBOL) }, implementationHash: { "wasm-component": wasmUnit.implementationHash, "js-module": jsUnit.implementationHash }, world: wasmUnit.implementation["world"] },
  sizes: { ...sizes, transpileDeterministic },
  perCall: {
    workerd: { clockReadingsAllWholeMs: readings.every(Number.isInteger), minReadingMs: Math.min(...readings), note: "Median of 7 runs of n calls inside one request; the in-Worker clock is coarse, so n is sized for >= tens of ms per run. Includes the caller's await per call.", ...workerd },
    node: { debugLogProbe, note: "Same glue and core module in Node's V8, to split the boundary: loweringAdapter = wire<->jco value conversion; jcoGlueAndWasm = canonical-ABI copy in the glue plus the computation.", ...node },
  },
  instantiation: {
    workerdReadyMs: { samples: workerdInstantiation, median: median(workerdInstantiation), note: "First instantiate() of the glue with the precompiled core module in a fresh isolate, by the in-Worker clock (ms resolution)." },
    workerdFirstCallMs: workerdFirstCall,
    nodeCompileCoreMs: { median: round(median(compileSamples)), note: "WebAssembly.compile of the core module. A Worker gets it precompiled as a module import; this is the work deploy/upload pays." },
    nodeInstantiateMs: { median: round(median(instSamples)), p90: round([...instSamples].sort((a, b) => a - b)[Math.floor(instSamples.length * 0.9)]!) },
    nodeFirstCallMs: { median: round(median(firstCallSamples)) },
  },
  missing: [
    "Deployed Cloudflare Workers numbers (cold start, CPU time per call, isolate memory): not measured; everything here is local.",
    "Script-size effect on real cold start across a closure of many units.",
    "Calls that cross capability imports (WASM -> host handles): the T5 unit is pure and the harness does not wire imports yet.",
    "componentize-js or other non-Rust component sources.",
  ],
  caller: { bytes: new TextEncoder().encode(CALLER).byteLength, identicalForBothKinds: true },
};
writeFileSync(join(import.meta.dirname, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify({ sizes: { component: sizes.component, transpiled }, workerd, node, instantiation: results.instantiation }, null, 2));
