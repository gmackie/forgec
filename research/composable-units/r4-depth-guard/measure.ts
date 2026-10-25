// FORG-49 measurements, the way FORG-42 took them (../r3-runtime-cost/measure.ts): per-script and total
// deploy bytes per strategy, and what a one-body edit re-uploads. Sizes only: no latency (the depth guard
// adds no call). Run from the repository root after building (see run.sh):
//   node research/composable-units/r4-depth-guard/measure.ts results/measure.json
// The output path is relative to this directory. FORG-49 ran it once on the unchanged tree (main 6b30f4d,
// `results/before.json`) and once with the change (`results/measure.json`).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seal, writeSealed, type UnitPlan } from "../../../packages/units/src/index.ts";
import { link, type Link } from "../../../packages/linker-packed/src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const here = import.meta.dirname;
const forgec = join(root, "target/debug/forgec");
const out = process.argv[2];
if (!out) throw new Error("usage: measure.ts <output, relative to this directory>");
const scratch: string[] = [];
const STRATEGIES = ["single", "per-entry-point", "per-entry-point-shared"];

function copyAcme(edit?: (app: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-r4dg-"));
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
  return { count: s.length, min: s[0] ?? 0, median: s[Math.floor(s.length / 2)] ?? 0, max: s.at(-1) ?? 0 };
};

/** Every uploaded script: the group scripts, the router and (shared) the runtime Worker. */
const uploads = (l: Link) => [
  ...l.scripts.map((s) => ({ name: s.name, scriptHash: s.scriptHash, raw: s.bytes!.raw, gzip: s.bytes!.gzip })),
  ...(l.router ? [{ name: l.router.name, scriptHash: l.router.scriptHash, raw: l.router.bytes!.raw, gzip: l.router.bytes!.gzip }] : []),
  ...(l.runtime ? [{ name: l.runtime.name, scriptHash: l.runtime.scriptHash, raw: l.runtime.bytes!.raw, gzip: l.runtime.bytes!.gzip }] : []),
];

function summarize(l: Link) {
  const all = uploads(l);
  const inProcess = l.scripts.filter((s) => s.runtime?.mode === "in-process");
  return {
    scripts: l.scripts.length,
    uploads: all.length,
    router: l.router ? { raw: l.router.bytes!.raw, gzip: l.router.bytes!.gzip } : null,
    runtimeWorker: l.runtime ? { raw: l.runtime.bytes!.raw, gzip: l.runtime.bytes!.gzip } : null,
    raw: stats(l.scripts.map((s) => s.bytes!.raw)),
    gzip: stats(l.scripts.map((s) => s.bytes!.gzip)),
    scriptsCarryingEngine: l.scripts.filter((s) => (s.composition?.["runtime"] ?? 0) > 20_000).length,
    scriptsCarryingEffect: l.scripts.filter((s) => (s.composition?.["effect"] ?? 0) > 0).length,
    inProcess: inProcess.map((s) => ({ members: s.members.length > 3 ? `${s.members.length} members` : s.members, reason: s.runtime!.reason, raw: s.bytes!.raw, gzip: s.bytes!.gzip })),
    inProcessRaw: inProcess.reduce((n, s) => n + s.bytes!.raw, 0),
    deployRaw: all.reduce((n, s) => n + s.raw, 0),
    deployGzip: all.reduce((n, s) => n + s.gzip, 0),
    perScript: l.scripts.map((s) => ({ name: s.name, members: s.members.length > 3 ? `${s.members.length} members` : s.members, raw: s.bytes!.raw, gzip: s.bytes!.gzip, runtime: s.runtime?.mode ?? "in-process" })),
  };
}

function bodyEditDiff(base: Awaited<ReturnType<typeof buildAndLink>>, edited: Awaited<ReturnType<typeof buildAndLink>>) {
  return Object.fromEntries(
    STRATEGIES.map((strategy) => {
      const before = new Map(uploads(base.links[strategy]!).map((s) => [s.name, s.scriptHash]));
      const after = uploads(edited.links[strategy]!);
      const changed = after.filter((s) => before.get(s.name) !== s.scriptHash);
      return [strategy, { uploads: after.length, reuploaded: changed.length, reuploadedRaw: changed.reduce((n, s) => n + s.raw, 0), reuploadedGzip: changed.reduce((n, s) => n + s.gzip, 0), changed: changed.map((s) => `${s.name} (${s.raw})`) }];
    }),
  );
}

try {
  const base = await buildAndLink(copyAcme());
  const edited = await buildAndLink(
    copyAcme((app) => {
      const f = join(app, "impl/rebuild-order-summary.ts");
      const text = readFileSync(f, "utf8");
      if (!text.includes("{ rebuilt: true }")) throw new Error("edit target moved");
      writeFileSync(f, text.replace("{ rebuilt: true }", "{ rebuilt: false }"));
    }),
  );
  const result = {
    version: "r4-depth-guard-measure/1",
    issue: "FORG-49",
    local: true,
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain", "--", "packages"], { cwd: root, encoding: "utf8" }).trim() !== "",
    toolchain: { ...base.manifest.toolchain, node: process.version, linker: base.links["per-entry-point"]!.linker },
    manifestHash: base.manifest.manifestHash,
    bundling: "esbuild, minified, format esm, platform neutral, conditions source/workerd/worker/browser/import, cloudflare:* and node:* external; gzip -9 (FORG-29/37/42)",
    sizes: Object.fromEntries(STRATEGIES.map((s) => [s, summarize(base.links[s]!)])),
    bodyEdit: { edit: "impl/rebuild-order-summary.ts `{ rebuilt: true }` -> `{ rebuilt: false }`", ...bodyEditDiff(base, edited) },
  };
  writeFileSync(join(here, out), `${JSON.stringify(result, null, 2)}\n`);
  const s = result.sizes["per-entry-point-shared"]!;
  const e = result.bodyEdit["per-entry-point-shared"] as { reuploaded: number; reuploadedRaw: number; reuploadedGzip: number };
  console.log(JSON.stringify({ commit: result.commit, dirty: result.dirty, shared: { raw: s.raw, gzip: s.gzip, deployRaw: s.deployRaw, deployGzip: s.deployGzip, inProcess: s.inProcess.map((x) => x.reason), inProcessRaw: s.inProcessRaw, bodyEdit: e } }, null, 2));
} finally {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}
