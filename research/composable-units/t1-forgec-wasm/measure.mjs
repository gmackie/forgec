// Measures the running Worker (wrangler dev --local) and writes results/*.json.
// usage: node measure.mjs <worker-url> <native-build-dir> [runs]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

const [url, nativeDir, runsArg] = process.argv.slice(2);
if (!url || !nativeDir) throw new Error("usage: node measure.mjs <worker-url> <native-build-dir> [runs]");
const runs = Number(runsArg ?? 10);
const here = import.meta.dirname;
const results = join(here, "results");
const wasmBytes = readFileSync(join(here, "generated/forgec.wasm"));
const request = JSON.parse(readFileSync(join(here, "generated/acme-request.json"), "utf8"));
const write = (name, value) => writeFileSync(join(results, name), JSON.stringify(value, null, 2) + "\n");
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s.at(-1), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) };
};

// 1. Worker timings. The first request after `wrangler dev` starts is reported separately as "first".
async function hit(op) {
  const start = performance.now();
  const res = await fetch(`${url}/${op}`);
  const body = await res.json();
  const wall = performance.now() - start;
  if (!res.ok || !body[op]?.result?.ok) throw new Error(`${op} failed: ${JSON.stringify(body).slice(0, 500)}`);
  return { clientWallMs: +wall.toFixed(2), inIsolateMs: body[op].inIsolateMs.performance, memoryBytes: body.memoryBytes, body };
}
const first = { check: await hit("check"), build: await hit("build") };
const samples = { check: [], build: [] };
for (let i = 0; i < runs; i++) for (const op of ["check", "build"]) samples[op].push(await hit(op));
const summarize = (op) => ({
  first: { clientWallMs: first[op].clientWallMs, inIsolateMs: first[op].inIsolateMs },
  warm: {
    clientWallMs: stats(samples[op].map((s) => s.clientWallMs)),
    inIsolateMs: stats(samples[op].map((s) => s.inIsolateMs)),
  },
  cpuMs: null,
});
write("workerd-timings.json", {
  host: "wrangler dev --local (workerd), loopback HTTP",
  wrangler: process.env.WRANGLER_VERSION ?? null,
  runsPerOp: runs,
  measuredAt: new Date().toISOString(),
  notes: [
    "clientWallMs: fetch round trip from Node on the same machine, including HTTP and JSON (build response carries every artifact).",
    "inIsolateMs: performance.now() delta around the synchronous wasm call inside the isolate. Local workerd advanced its clock during the call; deployed Workers only advance clocks across I/O, so this reading is not available there.",
    "cpuMs: local workerd does not report per-request CPU time (its observability spans carry duration_ms only), so it is missing, not zero. The synchronous inIsolateMs is the closest local proxy. See node-v8-cpu.json for process CPU time of the same module under Node's V8.",
    "first: the first request the dev server receives (check, then build). V8 compiles wasm functions lazily and tiers them up, so first calls include compilation of the code they touch.",
  ],
  check: summarize("check"),
  build: summarize("build"),
  wasmMemoryBytesAfterRuns: samples.build.at(-1).memoryBytes,
});

// 2. Byte-for-byte parity of the Worker's build output with the native CLI's.
const workerFiles = samples.build.at(-1).body.build.result.files;
const nativeFiles = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else nativeFiles[relative(nativeDir, p)] = readFileSync(p);
  }
};
walk(nativeDir);
const paths = [...new Set([...Object.keys(nativeFiles), ...Object.keys(workerFiles)])].sort();
const comparison = paths.map((path) => {
  const native = nativeFiles[path];
  const worker = workerFiles[path] === undefined ? undefined : Buffer.from(workerFiles[path], "utf8");
  return {
    path,
    nativeBytes: native?.length ?? null,
    workerBytes: worker?.length ?? null,
    identical: native !== undefined && worker !== undefined && native.equals(worker),
  };
});
write("parity.json", {
  compared: "forgec build examples/acme (native, this commit) vs forgec_build in workerd",
  allIdentical: comparison.every((c) => c.identical),
  files: comparison,
});

// The Worker's last responses, with artifact contents replaced by their size and digest.
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const lastBuild = samples.build.at(-1).body.build.result;
write("workerd-response.json", {
  check: samples.check.at(-1).body.check.result,
  build: {
    ...lastBuild,
    files: Object.fromEntries(
      Object.entries(lastBuild.files).map(([path, text]) => [path, { bytes: Buffer.byteLength(text), sha256: sha256(text) }]),
    ),
  },
});

// 3. Size against Workers limits.
const gz = gzipSync(wasmBytes, { level: 9 }).length;
const sourceBytes = Buffer.byteLength(JSON.stringify(request));
write("size.json", {
  wasm: { file: "forgegraph_wasm.wasm (cargo build --release, workspace default profile)", rawBytes: wasmBytes.length, gzipBytes: gz },
  bundledAcmeRequestBytes: sourceBytes,
  limits: {
    source: "Cloudflare Workers platform limits page (developers.cloudflare.com/workers/platform/limits/), as recalled; not re-fetched for this run",
    workerSizeCompressed: { free: "3 MB", paid: "10 MB", note: "limit applies to the gzip-compressed upload" },
    memoryPerIsolate: "128 MB",
    cpuPerRequest: { free: "10 ms", paid: "30 s default, configurable higher" },
    startup: "Worker global scope must finish within the startup limit (about 1 s; unverified)",
  },
});

// 4. The same module under Node's V8, for process CPU time workerd cannot report.
const module = new WebAssembly.Module(wasmBytes);
const instance = new WebAssembly.Instance(module, {});
const { memory, forgec_alloc, forgec_free } = instance.exports;
const call = (name) => {
  const input = new TextEncoder().encode(JSON.stringify(request));
  const ptr = forgec_alloc(input.length);
  new Uint8Array(memory.buffer, ptr, input.length).set(input);
  const packed = instance.exports[`forgec_${name}`](ptr, input.length);
  forgec_free(ptr, input.length);
  const outPtr = Number(packed >> 32n), outLen = Number(packed & 0xffffffffn);
  const text = new TextDecoder().decode(new Uint8Array(memory.buffer, outPtr, outLen));
  forgec_free(outPtr, outLen);
  return JSON.parse(text);
};
const cpu = { check: [], build: [] };
for (let i = 0; i < runs + 1; i++)
  for (const op of ["check", "build"]) {
    const before = process.cpuUsage();
    if (!call(op).ok) throw new Error(`node ${op} failed`);
    const used = process.cpuUsage(before);
    if (i > 0) cpu[op].push(+((used.user + used.system) / 1000).toFixed(2));
  }
const compileStart = performance.now();
new WebAssembly.Module(wasmBytes);
write("node-v8-cpu.json", {
  host: `node ${process.version} (V8 ${process.versions.v8}), not workerd`,
  note: "process.cpuUsage() around one synchronous call, after one discarded warm-up. It is process-wide (GC and compiler helper threads included), so tails are noisy; a proxy for isolate CPU, not a Workers measurement",
  check: stats(cpu.check),
  build: stats(cpu.build),
  wasmModuleCompileMs: +(performance.now() - compileStart).toFixed(2),
  wasmModuleCompileNote: "synchronous new WebAssembly.Module on an already-seen module; V8 compiles function bodies lazily, so this is not full compilation cost",
});
console.log(JSON.stringify({ parity: comparison.every((c) => c.identical), rawBytes: wasmBytes.length, gzipBytes: gz }));
