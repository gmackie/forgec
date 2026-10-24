// FORG-28 measurements for examples/acme. Run from the repository root after `cargo build -p forgegraph-cli`:
//   node research/composable-units/t2-units/measure.ts
// Writes results.json and manifest.acme.json next to this file. Every number here is measured on
// the machine that ran it; nothing is estimated (the README marks estimates separately).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { seal, stableJson, writeSealed, type UnitPlan } from "../../../packages/units/src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const app = join(root, "examples/acme");
const here = import.meta.dirname;
const { build, transform } = createRequire(join(root, "packages/units/package.json"))("esbuild") as typeof import("esbuild");

const sizes = async (code: Uint8Array | string) => {
  const text = typeof code === "string" ? code : Buffer.from(code).toString("utf8");
  const min = (await transform(text, { minify: true, format: "esm", target: "es2022", loader: "js" })).code;
  return { raw: Buffer.byteLength(text), minified: Buffer.byteLength(min), minifiedGzip: gzipSync(min, { level: 9 }).byteLength };
};

const t0 = performance.now();
execFileSync(join(root, "target/debug/forgec"), ["build", app, "--units"], { stdio: "pipe" });
const planMs = performance.now() - t0;
const out = join(app, "generated/units");
const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as UnitPlan;
const t1 = performance.now();
const sealed = await seal(plan, app);
const sealMs = performance.now() - t1;
writeSealed(sealed, out);
const again = await seal(plan, app);
const m = sealed.manifest;

// Per js-module unit: its own module (shared libraries external), and the same module with the
// runtime and Effect inlined, i.e. what one isolate would load if nothing were shared.
const units = [];
for (const [hash, u] of Object.entries(m.units)) {
  if (u.kind !== "js-module") continue;
  const blob = u.implementation["module"] as string;
  const own = await sizes(sealed.modules.get(blob)!);
  const site = m.modules[blob]!.sources[0]!;
  const standalone = await build({
    stdin: { contents: readFileSync(join(out, m.modules[blob]!.path), "utf8"), resolveDir: app, sourcefile: "unit.js", loader: "js" },
    absWorkingDir: app, bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
    mainFields: ["module", "main"], conditions: ["source", "workerd", "worker", "browser", "import"], external: ["cloudflare:*", "node:*"], minify: true, legalComments: "none", logLevel: "silent", metafile: true,
  });
  const saInputs = Object.values(standalone.metafile.outputs)[0]!.inputs;
  const sa = standalone.outputFiles[0]!.contents;
  units.push({
    symbol: u.symbol, role: u.role, unitHash: hash, source: site, libraries: u.implementation["libraries"],
    module: own,
    standaloneWithLibraries: {
      minified: sa.byteLength,
      minifiedGzip: gzipSync(sa, { level: 9 }).byteLength,
      awsSdkBytesInOutput: Object.entries(saInputs).filter(([k]) => /@aws-sdk|@smithy/.test(k)).reduce((n, [, v]) => n + v.bytesInOutput, 0),
    },
    findings: u.findings,
  });
}
units.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));

// Whole-app comparisons. impl-only: every impl body in one module, same externals as the units.
const implOnly = await build({
  entryPoints: [join(app, "impl/index.ts")], absWorkingDir: app, bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
  mainFields: ["module", "main"], external: ["effect", "effect/*", "@forgegraph/runtime", "@forgegraph/runtime/*"], legalComments: "none", logLevel: "silent",
});
// Full Worker: the Cloudflare entrypoint with runtime, Effect and app.json, as wrangler would ship it.
const worker = await build({
  entryPoints: [join(app, "deploy/cloudflare/worker.ts")], absWorkingDir: app, bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
  mainFields: ["module", "main"], conditions: ["source", "workerd", "worker", "browser", "import"], external: ["cloudflare:*", "node:*"], minify: true, legalComments: "none", logLevel: "silent", metafile: true,
});
const workerBytes = worker.outputFiles[0]!.contents;
const workerInputs = Object.entries(worker.metafile.outputs)[0]![1].inputs;
const share = (re: RegExp) => Object.entries(workerInputs).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v.bytesInOutput, 0);

const closures = m.entryPoints.filter((e) => e.root).map((e) => e.closure.length).sort((a, b) => a - b);
const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [key(x)]: (acc[key(x)] ?? 0) + 1 }), {});
const hostEnv = [...readFileSync(join(root, "packages/runtime/src/hosts/cloudflare.ts"), "utf8").matchAll(/\benv\.([A-Z_]+)/g)].map((x) => x[1]!);

const results = {
  version: "t2-units-results/1",
  issue: "FORG-28",
  measured: {
    toolchain: m.toolchain,
    manifestHash: m.manifestHash,
    reproducible: { sameProcess: stableJson(again.manifest) === stableJson(m), test: "packages/units/test/units.test.ts (two scratch copies, byte compare of manifest + modules)" },
    timingsMs: { planWithForgecDebugBuild: Math.round(planMs), sealAndBundle: Math.round(sealMs) },
    units: { total: Object.keys(m.units).length, byKind: count(Object.values(m.units), (u) => u.kind), byRole: count(Object.values(m.units), (u) => u.role), modules: Object.keys(m.modules).length },
    entryPoints: {
      total: m.entryPoints.length,
      byKind: count(m.entryPoints, (e) => e.kind),
      runtimeServed: m.entryPoints.filter((e) => !e.root).map((e) => ({ id: e.id, service: e.runtimeService })),
      closureSize: { min: closures[0], median: closures[Math.floor(closures.length / 2)], max: closures.at(-1) },
      largestClosures: m.entryPoints.filter((e) => e.closure.length === closures.at(-1)).map((e) => e.id),
    },
    jsUnits: units,
    wholeApp: {
      implOnly: await sizes(implOnly.outputFiles[0]!.contents),
      cloudflareWorker: {
        minified: workerBytes.byteLength,
        minifiedGzip: gzipSync(workerBytes, { level: 9 }).byteLength,
        bytesInOutput: { effect: share(/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?effect\//), runtime: share(/packages\/runtime\//), appJson: share(/generated\/app\.json$/), impl: share(/^impl\//) },
      },
    },
    artifacts: { planBytes: Buffer.byteLength(readFileSync(join(out, "plan.json"))), manifestBytes: Buffer.byteLength(stableJson(m)) },
    rawEnv: {
      implFindings: units.flatMap((u) => u.findings.map((f) => ({ unit: u.symbol, ...f }))),
      hostEnvReferences: count(hostEnv, (x) => x),
      hostFile: "packages/runtime/src/hosts/cloudflare.ts",
    },
  },
};
writeFileSync(join(here, "results.json"), stableJson(results));
writeFileSync(join(here, "manifest.acme.json"), stableJson(m));
console.log(JSON.stringify(results.measured.units), JSON.stringify(results.measured.wholeApp));
