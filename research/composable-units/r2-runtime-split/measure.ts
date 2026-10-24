// FORG-37 measurements: linker A over examples/acme with the runtime split by feature. Run from the
// repository root after `cargo build -p forgegraph-cli` and building the runtime (see run.sh):
//   node research/composable-units/r2-runtime-split/measure.ts <label>
// Writes results/<label>.json: per-script sizes (raw, gzip -9), total deploy bytes, the bytes a one-body
// edit re-uploads, and what five representative scripts import (esbuild metafile, bytes in output per
// module). Same esbuild settings as FORG-29 (research/composable-units/t3-linker-packed), so the
// numbers compare with its results/sizes.json and results/edits.json.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seal, stableJson, writeSealed, type UnitPlan } from "../../../packages/units/src/index.ts";
import { link, type Link } from "../../../packages/linker-packed/src/index.ts";
import { bundleWholeApp } from "../t3-linker-packed/baseline.ts";

const root = resolve(import.meta.dirname, "../../..");
const here = import.meta.dirname;
const label = process.argv[2] ?? "after";
const forgec = join(root, "target/debug/forgec");
const { build } = createRequire(join(root, "packages/linker-packed/package.json"))("esbuild") as typeof import("esbuild");
const scratch: string[] = [];
const STRATEGIES = ["single", "per-entry-point"] as const;
/** The task's representative entry points: member id -> what it stands for. */
const REPRESENTATIVE: Record<string, string> = {
  "GET /v1/customers/{id}": "simple CRUD read",
  "POST /v1/orders/{order}/submit": "write with outbox (function unit, forwards dispatch)",
  "@acme/commerce/_/ProcessOrder": "workflow class with its steps",
  "fulfill-order": "queue consumer",
  "forge:sweep": "sweep (dispatch owner, whole app.json)",
};

function copyAcme(edit?: (app: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-r2-"));
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
  for (const strategy of STRATEGIES) links[strategy] = await link({ app, manifestDir: units, environment: join(app, "deploy/cloudflare/wrangler.jsonc"), strategy, out: join(app, "generated/linked", strategy) });
  return { app, manifest: sealed.manifest, links };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { count: s.length, min: s[0] ?? 0, median: s[Math.floor(s.length / 2)] ?? 0, max: s.at(-1) ?? 0, total: s.reduce((n, x) => n + x, 0) };
};

function summarize(l: Link) {
  const scripts = l.scripts.map((s) => ({ name: s.name, members: s.members, raw: s.bytes!.raw, gzip: s.bytes!.gzip, composition: s.composition, appJson: s.slice.mode, features: (s as { features?: string[] | null }).features ?? null }));
  return {
    scripts: l.scripts.length,
    router: l.router ? { raw: l.router.bytes!.raw, gzip: l.router.bytes!.gzip } : null,
    raw: stats(scripts.map((s) => s.raw)),
    gzip: stats(scripts.map((s) => s.gzip)),
    runtimePlusEffect: stats(scripts.map((s) => (s.composition?.["runtime"] ?? 0) + (s.composition?.["effect"] ?? 0))),
    deployRaw: scripts.reduce((n, s) => n + s.raw, 0) + (l.router?.bytes?.raw ?? 0),
    deployGzip: scripts.reduce((n, s) => n + s.gzip, 0) + (l.router?.bytes?.gzip ?? 0),
    perScript: scripts,
  };
}

/** What a script imports: bytes in the minified output per input module (esbuild metafile). */
async function imports(app: string, dir: string) {
  const result = await build({
    entryPoints: [join(dir, "entry.mjs")], absWorkingDir: app, bundle: true, write: false, metafile: true, format: "esm", platform: "neutral", target: "es2022",
    mainFields: ["module", "main"], conditions: ["source", "workerd", "worker", "browser", "import"], external: ["cloudflare:*", "node:*"], nodePaths: [join(app, "node_modules")],
    alias: { "@forgegraph/linker-packed/host": join(root, "packages/linker-packed/src/host.ts") }, minify: true, legalComments: "none", charset: "utf8", logLevel: "silent",
  });
  const inputs = Object.values(result.metafile.outputs)[0]!.inputs;
  const modules: Record<string, number> = {};
  for (const [file, v] of Object.entries(inputs)) {
    if (!v.bytesInOutput) continue;
    const key = file.replace(/.*node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/, "").replace(/.*packages\//, "").replace(/.*\/units\/([0-9a-f]{8})[0-9a-f]+\.js$/, "unit:$1").replace(/.*\/(app\.slice\.json|entry\.mjs)$/, "$1");
    modules[key] = (modules[key] ?? 0) + v.bytesInOutput;
  }
  const sorted = Object.fromEntries(Object.entries(modules).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  const runtime = Object.entries(modules).filter(([k]) => k.startsWith("runtime/")).reduce((n, [, b]) => n + b, 0);
  const effect = Object.entries(modules).filter(([k]) => k.startsWith("effect/")).reduce((n, [, b]) => n + b, 0);
  return { raw: result.outputFiles[0]!.contents.byteLength, runtime, effect, runtimeModules: Object.keys(modules).filter((k) => k.startsWith("runtime/")).length, effectModules: Object.keys(modules).filter((k) => k.startsWith("effect/")).length, modules: sorted };
}

/** Effect's floor: the smallest programs that run an Effect, bundled the same way. */
async function effectFloor(app: string) {
  const programs: Record<string, string> = {
    "Effect.runPromise(Effect.succeed(1))": `import { Effect } from "effect"; export default () => Effect.runPromise(Effect.succeed(1));`,
    "a service through a Layer (what the engine needs)": `import { Cause, Context, Effect, Layer } from "effect"; class S extends Context.Service()("s") {} const l = Layer.mergeAll(Layer.succeed(S)({ a: 1 })); export default () => Effect.runPromise(Effect.gen(function* () { return (yield* S).a; }).pipe(Effect.provide(l), Effect.catchCause((c) => Effect.succeed(Cause.pretty(c)))));`,
  };
  const out: Record<string, number> = {};
  for (const [name, contents] of Object.entries(programs)) {
    const r = await build({ stdin: { contents, resolveDir: app, sourcefile: "floor.mjs" }, absWorkingDir: app, bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", mainFields: ["module", "main"], conditions: ["source", "workerd", "worker", "browser", "import"], nodePaths: [join(app, "node_modules")], minify: true, legalComments: "none", logLevel: "silent" });
    out[name] = r.outputFiles[0]!.contents.byteLength;
  }
  return out;
}

function bodyEditDiff(base: Awaited<ReturnType<typeof buildAndLink>>, edited: Awaited<ReturnType<typeof buildAndLink>>) {
  return Object.fromEntries(
    STRATEGIES.map((strategy) => {
      const before = new Map(base.links[strategy]!.scripts.map((s) => [s.name, s]));
      const changed = edited.links[strategy]!.scripts.filter((s) => before.get(s.name)?.scriptHash !== s.scriptHash);
      return [strategy, { scripts: edited.links[strategy]!.scripts.length, reuploaded: changed.length, reuploadedRaw: changed.reduce((n, s) => n + s.bytes!.raw, 0), reuploadedGzip: changed.reduce((n, s) => n + s.bytes!.gzip, 0), changed: changed.map((s) => s.members.length > 3 ? `${s.name} (${s.members.length} members)` : s.name) }];
    }),
  );
}

try {
  const base = await buildAndLink(copyAcme());
  const wholeDir = mkdtempSync(join(tmpdir(), "forge-r2-whole-"));
  scratch.push(wholeDir);
  const wholeApp = await bundleWholeApp(join(root, "examples/acme"), wholeDir);
  const pe = base.links["per-entry-point"]!;
  const representative: Record<string, unknown> = {};
  for (const [member, what] of Object.entries(REPRESENTATIVE)) {
    const s = pe.scripts.find((x) => x.members.includes(member) || x.members.some((m) => m.endsWith(`/${member}`)));
    if (!s) throw new Error(`no script for ${member}`);
    representative[member] = { what, script: s.name, members: s.members, features: (s as { features?: string[] | null }).features ?? null, gzip: s.bytes!.gzip, ...(await imports(base.app, join(base.app, "generated/linked/per-entry-point", s.name))) };
  }
  const bodyEdit = await buildAndLink(
    copyAcme((app) => {
      const f = join(app, "impl/rebuild-order-summary.ts");
      const text = readFileSync(f, "utf8");
      if (!text.includes("{ rebuilt: true }")) throw new Error("edit target moved");
      writeFileSync(f, text.replace("{ rebuilt: true }", "{ rebuilt: false }"));
    }),
  );
  const out = {
    version: "r2-runtime-split/1",
    issue: "FORG-37",
    label,
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    measured: {
      toolchain: { ...base.manifest.toolchain, node: process.version, linker: pe.linker },
      manifestHash: base.manifest.manifestHash,
      bundling: "esbuild, minified, format esm, platform neutral, conditions source/workerd/worker/browser/import, cloudflare:* and node:* external; gzip -9",
      wholeAppWorker: { ...wholeApp, source: "examples/acme/deploy/cloudflare/worker.ts" },
      strategies: Object.fromEntries(STRATEGIES.map((s) => [s, summarize(base.links[s]!)])),
      bodyEdit: { edit: "impl/rebuild-order-summary.ts `{ rebuilt: true }` -> `{ rebuilt: false }`", ...bodyEditDiff(base, bodyEdit) },
      representative,
      effectFloor: await effectFloor(base.app),
    },
  };
  writeFileSync(join(here, `results/${label}.json`), stableJson(out));
  const s = out.measured.strategies["per-entry-point"];
  console.log(JSON.stringify({ label, wholeApp: wholeApp.bytes, single: out.measured.strategies.single.raw, perEntryPoint: { raw: s.raw, gzip: s.gzip, deployRaw: s.deployRaw, deployGzip: s.deployGzip, runtimePlusEffect: s.runtimePlusEffect }, bodyEdit: Object.fromEntries(STRATEGIES.map((k) => [k, { n: out.measured.bodyEdit[k].reuploaded, raw: out.measured.bodyEdit[k].reuploadedRaw, gzip: out.measured.bodyEdit[k].reuploadedGzip }])) }, null, 1));
} finally {
  scratch.forEach((d) => rmSync(d, { recursive: true, force: true }));
}
