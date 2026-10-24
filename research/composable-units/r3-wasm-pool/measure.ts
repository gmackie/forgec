// R3 (FORG-41) evidence: how a WASM unit should map concurrent calls to component instances.
// jco serializes calls on one JSPI instance (R2), so the options are compared in workerd, locally:
//
//   shared        one instance for every call (the harness before FORG-41)
//   fresh         a new instance per call, from the compiled core modules (no reuse)
//   pool(4)       a bounded pool: at most 4 instances, calls beyond them wait
//   pool(32)      the same with 32 (the harness default)
//   elastic(8)    an instance per in-flight call (no bound), idle ones reused, at most 8 kept idle
//   elastic(32)   the same, at most 32 kept idle
//
// against the JS unit, at 1, 2, 8 and 32 concurrent calls (and 64 with I/O, past the bound), plus instantiation cost, memory per
// instance, and what a trap or a host failure mid-call does to the instance and to later calls.
//
//   cargo build -p forgegraph-cli && node research/composable-units/r3-wasm-pool/measure.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, loadavg, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { bindUnit, type BoundUnit, type InstanceStrategy, type WorkerModule } from "../../../packages/units/src/harness.ts";
import { seal, type UnitPlan } from "../../../packages/units/src/seal.ts";
import { TRANSPILER } from "../../../packages/units/src/wasm.ts";
import { TOOLCHAIN } from "../../../examples/pricing/build-component.mjs";

const root = resolve(import.meta.dirname, "../../..");
const units = createRequire(join(root, "packages/units/package.json"));
const { Miniflare } = units("miniflare") as typeof import("miniflare");
type Miniflare = InstanceType<typeof Miniflare>;
const pricing = join(root, "examples/pricing");
const SYMBOL = "@acme/pricing/_/PriceCart";
const COMPAT = "2026-07-01";
const CONCURRENCY = [1, 2, 8, 32];
const ITEMS = 5;
const round = (x: number, d = 3) => Number(x.toFixed(d));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const enc = (s: string) => new TextEncoder().encode(s);
const esm = (path: string, contents: string): WorkerModule => ({ type: "ESModule", path, contents: enc(contents) });
const scratch: string[] = [];
const missing: string[] = [
  "Deployed Cloudflare Workers: production isolates, their memory limit (128 MB per isolate) in practice, cold start and CPU time. Everything here is local workerd.",
  "Stack memory per suspended call (JSPI's secondary stack per promising() call): not measured separately; it is inside the workerd RSS deltas, not attributed.",
];

// ------------------------------------------------------------------ the unit and the host

const planDir = mkdtempSync(join(tmpdir(), "r3-plan-"));
scratch.push(planDir);
execFileSync(join(root, "target/debug/forgec"), ["build", pricing, "--units", "--out", planDir], { stdio: "pipe" });
const plan = JSON.parse(readFileSync(join(planDir, "units/plan.json"), "utf8")) as UnitPlan;
const js = await seal(plan, pricing);
const wasm = await seal(plan, pricing, { components: { [SYMBOL]: "impl/price-cart.wasm" } });

/**
 * Reads take `config.waitMs` (0: no I/O at all, the read resolves from memory). Product ids pick
 * the outcome: `trap-*` answers a price the Rust unit cannot parse (it aborts: a WASM trap, after
 * earlier reads in the same call), `throw-*` makes the handle throw (a host defect), `missing-*` is
 * the handle's NotFound (a declared failure). Every read is logged, to see interleaving.
 */
const HOST = `export const config = { waitMs: 0 };
export const log = [];
export function capability() {
  return {
    async get(id) {
      log.push(id);
      if (config.waitMs) await scheduler.wait(config.waitMs);
      if (id.startsWith("throw-")) throw new Error("host defect reading " + id);
      if (id.startsWith("missing-")) return { ok: false, code: "NotFound", detail: "Product " + id + " does not exist" };
      return { ok: true, value: { id, sku: id.toUpperCase(), unitPrice: id.startsWith("trap-") ? "not-a-price" : "1.25", active: true } };
    },
  };
}
`;

/** One endpoint per measurement; every time is in-Worker (performance.now). */
const BENCH = `import * as bound from "./bound.js";
import { config, log } from "./host.js";
const cart = (tag, n, bad) => ({ items: Array.from({ length: n }, (_, i) => ({ product: (i === n - 1 && bad ? bad + "-" : "") + tag + (i + 1), quantity: 1 })) });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeout = (p, ms) => Promise.race([p.then((r) => ({ settled: "ok", value: r }), (e) => ({ settled: "threw", error: String(e?.message ?? e).slice(0, 160) })), scheduler.wait(ms).then(() => ({ settled: "hung" }))]);
// Every core instance the glue creates, to read linear memory sizes.
const instances = [];
const instantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async (...a) => { const r = await instantiate.apply(WebAssembly, a); instances.push(r.instance ?? r); return r; };
const memoryBytes = (from, to) => instances.slice(from, to).reduce((s, i) => s + (i.exports.memory instanceof WebAssembly.Memory ? i.exports.memory.buffer.byteLength : 0), 0);
const held = [];
export default { async fetch(request) {
  const url = new URL(request.url);
  const body = request.method === "POST" ? await request.json() : {};
  config.waitMs = body.waitMs ?? 0;
  switch (url.pathname) {
    case "/instantiate": {
      // n sequential bare instances (no call), then one call on a fresh instance vs a warm one.
      if (!bound.create) return Response.json(null);
      const from = instances.length;
      const t0 = performance.now();
      const first = await bound.create();
      const firstMs = performance.now() - t0;
      const coreInstancesPerUnit = instances.length - from;
      const memoryPerInstance = memoryBytes(from);
      const t1 = performance.now();
      for (let i = 1; i < body.n; i++) await bound.create();
      const meanMs = (performance.now() - t1) / (body.n - 1);
      const input = cart("p", ${ITEMS});
      const t2 = performance.now();
      for (let i = 0; i < body.n; i++) await first(input);
      const warmCallMs = (performance.now() - t2) / body.n;
      const t3 = performance.now();
      for (let i = 0; i < body.n; i++) await (await bound.create())(input);
      const freshCallMs = (performance.now() - t3) / body.n;
      // The first instance served body.n calls: its memory after them.
      return Response.json({ firstMs, meanMs, warmCallMs, freshCallMs, coreInstancesPerUnit, linearMemoryBytesPerInstance: memoryPerInstance, linearMemoryBytesAfterCalls: memoryBytes(from, from + coreInstancesPerUnit) });
    }
    case "/hold": {
      for (let i = 0; i < body.n; i++) held.push(await bound.create());
      return Response.json({ held: held.length });
    }
    case "/throughput": {
      // rounds of c concurrent calls; each call reads ${ITEMS} products.
      const { c, rounds } = body;
      await bound.ready();
      const ms = [];
      let order = [];
      let allOk = true;
      for (let r = 0; r < rounds; r++) {
        log.length = 0;
        const t0 = performance.now();
        const out = await Promise.all(Array.from({ length: c }, (_, k) => bound.invoke(cart("c" + k + "-", ${ITEMS}))));
        ms.push(performance.now() - t0);
        allOk &&= out.every((x) => x.ok && x.value.lines.length === ${ITEMS});
        if (r === 0) order = [...log];
      }
      // Interleaved: every call made its first read before any call made its last.
      const firstReads = order.map((id, i) => [id, i]).filter(([id]) => id.endsWith("-1")).map(([, i]) => i);
      const lastReads = order.map((id, i) => [id, i]).filter(([id]) => id.endsWith("-${ITEMS}")).map(([, i]) => i);
      const interleaved = c === 1 ? null : Math.max(...firstReads) < Math.min(...lastReads);
      return Response.json({ medianMs: median(ms), totalMs: ms.reduce((a, b) => a + b, 0), rounds, allOk, interleaved, readOrderHead: order.slice(0, 12), stats: bound.stats?.() ?? null });
    }
    case "/failure": {
      // A call fails mid-call (after earlier reads resumed) while two good calls on the same isolate
      // are suspended; then later calls run. Nothing may hang, and every good call must be correct.
      const { bad } = body;
      await bound.ready();
      log.length = 0;
      const during = await Promise.all([timeout(bound.invoke(cart("a", 3)), 2000), timeout(bound.invoke(cart("x", 3, bad)), 2000), timeout(bound.invoke(cart("b", 3)), 2000)]);
      const after = [];
      for (let i = 0; i < 3; i++) after.push(await timeout(bound.invoke(cart("after" + i + "-", 3)), 2000));
      const concurrentAfter = await Promise.all([timeout(bound.invoke(cart("y", 3)), 2000), timeout(bound.invoke(cart("z", 3)), 2000)]);
      const summarize = (r) => r.settled === "ok" ? (r.value.ok ? { settled: "ok", subtotal: r.value.value.subtotal } : { settled: "ok", code: r.value.code }) : r;
      return Response.json({ during: during.map(summarize), after: after.map(summarize), concurrentAfter: concurrentAfter.map(summarize), stats: bound.stats?.() ?? null });
    }
  }
  return new Response("not found", { status: 404 });
}};
`;

async function worker<T>(modules: WorkerModule[], f: (mf: Miniflare) => Promise<T>): Promise<T> {
  const mf = new Miniflare({ modules, compatibilityDate: COMPAT });
  try {
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
const bench = (b: BoundUnit) => b.modules.map((m) => (m.path === "caller.js" ? esm("caller.js", BENCH) : m.path === "host.js" ? esm("host.js", HOST) : m));

/** Resident set of the workerd process Miniflare spawned for `mf` (the only one alive), in KiB. */
function workerdRssKiB(): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter(([, , , comm]) => comm?.endsWith("workerd"));
  const mine = rows.filter(([, ppid]) => Number(ppid) === process.pid);
  if (mine.length !== 1) throw new Error(`expected one workerd child, found ${mine.length}`);
  return Number(mine[0]![2]);
}

const STRATEGIES: Record<string, InstanceStrategy> = {
  shared: "shared",
  fresh: { max: Number.POSITIVE_INFINITY, idle: 0 },
  "pool(4)": { max: 4, idle: 4 },
  "pool(32)": { max: 32, idle: 32 },
  "elastic(8)": { max: Number.POSITIVE_INFINITY, idle: 8 },
  "elastic(32)": { max: Number.POSITIVE_INFINITY, idle: 32 },
};
const bound: Record<string, BoundUnit> = { "js-module": await bindUnit(js, SYMBOL, pricing) };
for (const [name, instances] of Object.entries(STRATEGIES)) bound[name] = await bindUnit(wasm, SYMBOL, pricing, { instances });

// ------------------------------------------------------------------ 1. instantiation and memory

const instantiation = await worker(bench(bound["fresh"]!), async (mf) => {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await post(mf, "/instantiate", { n: 200 }));
  const pick = (k: string) => round(median(runs.map((r) => r[k] as number)), 4);
  return {
    note: "workerd, in-Worker clock. 5 runs of 200; medians. firstMs: the first instance in the run (core modules are compiled at upload, so no compilation). meanMs: each later bare instantiation. warmCallMs: a 5-read PriceCart call (in-memory reads) on an existing instance. freshCallMs: instantiate + the same call.",
    firstMs: pick("firstMs"),
    meanMs: pick("meanMs"),
    warmCallMs: pick("warmCallMs"),
    freshCallMs: pick("freshCallMs"),
    coreInstancesPerUnit: runs[0]!["coreInstancesPerUnit"],
    linearMemoryBytesPerInstance: runs[0]!["linearMemoryBytesPerInstance"],
    runs,
  };
});

const memory = await worker(bench(bound["fresh"]!), async (mf) => {
  await post(mf, "/hold", { n: 1 });
  const steps: Array<{ held: number; rssKiB: number }> = [];
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 300));
    return workerdRssKiB();
  };
  steps.push({ held: 1, rssKiB: await settle() });
  for (const n of [50, 100, 200]) {
    const held = (await post(mf, "/hold", { n: n - steps.at(-1)!.held })).held as number;
    steps.push({ held, rssKiB: await settle() });
  }
  const a = steps[0]!;
  const z = steps.at(-1)!;
  return {
    note: "Resident set of the workerd process while N bare instances are held live (ps rss, KiB), after 300 ms to settle. perInstanceKiB = (rss at 200 - rss at 1) / 199. It includes jco's per-instance JS objects, the core instances and their linear memory, all of which the pool keeps per idle instance.",
    steps,
    perInstanceKiB: round((z.rssKiB - a.rssKiB) / (z.held - a.held), 1),
  };
});

// ------------------------------------------------------------------ 2. concurrent throughput

const throughput: Record<string, Record<string, unknown>> = {};
for (const [host, waitMs, rounds] of [["io", 5, 9], ["memory", 0, 200]] as const) {
  throughput[host] = {};
  for (const [name, b] of Object.entries(bound)) {
    const rows: Record<string, unknown> = {};
    await worker(bench(b), async (mf) => {
      await post(mf, "/throughput", { c: 2, rounds: 3, waitMs }); // warm the isolate
      for (const c of waitMs ? [...CONCURRENCY, 64] : CONCURRENCY) {
        // memory: 8 requests of 25 rounds. One request of 200 can exceed workerd's 10,000 active
        // timeouts per request: jco polls with setTimeout while a call waits for the instance lock.
        const requests = waitMs ? 1 : 8;
        try {
          const rs = [];
          for (let q = 0; q < requests; q++) rs.push(await post(mf, "/throughput", { c, rounds: rounds / requests, waitMs }));
          const r = rs[0]!;
          // io: the median round. memory: rounds are often under the clock's 1 ms, so the mean of all of them.
          const ms = waitMs ? (r["medianMs"] as number) : rs.reduce((a, x) => a + (x["totalMs"] as number), 0) / rounds;
          rows[String(c)] = { ms: round(ms), callsPerSecond: ms > 0 ? round((c * 1000) / ms, 1) : null, interleaved: r["interleaved"], allOk: rs.every((x) => x["allOk"]), stats: rs.at(-1)!["stats"], readOrderHead: c === 2 ? r["readOrderHead"] : undefined };
        } catch (e) {
          rows[String(c)] = { error: String((e as Error).message).slice(0, 300) };
        }
      }
    });
    throughput[host]![name] = rows;
  }
}

// ------------------------------------------------------------------ 3. failure mid-call

const failure: Record<string, Record<string, unknown>> = {};
for (const bad of ["trap", "throw", "missing"]) {
  failure[bad] = {};
  for (const [name, b] of Object.entries(bound)) {
    failure[bad]![name] = await worker(bench(b), (mf) => post(mf, "/failure", { bad, waitMs: 5 }));
  }
}

// ------------------------------------------------------------------ results

const pkgVersion = (p: string) => (JSON.parse(readFileSync(join(root, "packages/units/node_modules", p, "package.json"), "utf8")) as { version: string }).version;
const results = {
  version: "r3-results/1",
  label: "local",
  measuredOn: { node: process.version, platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, loadAverageAtEnd: loadavg().map((x) => round(x, 2)), workerd: `miniflare@${pkgVersion("miniflare")} (bundled workerd)`, transpiler: TRANSPILER, component: TOOLCHAIN, compatibilityDate: COMPAT },
  unit: { symbol: SYMBOL, itemsPerCall: ITEMS, note: "Each call prices a 5-item cart: 5 sequential Product reads through the JSPI import." },
  strategies: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v === "shared" ? "shared" : { max: Number.isFinite(v.max) ? v.max : "unbounded", idle: v.idle }])),
  instantiation,
  memory,
  throughput: { note: "workerd, in-Worker clock, rounds of c concurrent calls on one isolate. io: every read waits 5 ms (scheduler.wait), ms is the median of 9 rounds. memory: reads resolve from memory with no I/O, ms is the mean of 200 rounds (single rounds are often under the clock's 1 ms resolution). The ideal for io is about 25 ms at any concurrency (5 sequential 5 ms reads). interleaved: every call made its first read before any call made its last.", ...throughput },
  failure: { note: "Three calls at once on one isolate, every read waiting 5 ms: a, then x whose last read fails, then b. Then three sequential calls and two concurrent ones. Each call is raced against a 2 s timer (hung). trap: the read answers a price the unit cannot parse, and it aborts (a WASM trap). throw: the handle throws (a host defect). missing: the handle's NotFound (a declared failure, returned as a result). Good calls price to 3.75.", ...failure },
  missing,
};
writeFileSync(join(import.meta.dirname, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(JSON.stringify({ instantiation: { ...instantiation, runs: undefined }, memory, throughput, failure }, null, 1));
