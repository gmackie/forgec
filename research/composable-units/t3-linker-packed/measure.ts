// FORG-29 measurements for linker A over examples/acme. Run from the repository root after
// `cargo build -p forgegraph-cli` and building the runtime (see run.sh):
//   node research/composable-units/t3-linker-packed/measure.ts
// Writes results/sizes.json and results/edits.json (or under $LINK_RESULTS, which r2-coverage/run.sh
// sets so a re-run does not overwrite this spike's record). Everything here is measured on this machine;
// nothing is estimated (the README labels estimates separately).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seal, stableJson, writeSealed, type UnitPlan } from "../../../packages/units/src/index.ts";
import { link, type Link } from "../../../packages/linker-packed/src/index.ts";
import { bundleWholeApp } from "./baseline.ts";

const root = resolve(import.meta.dirname, "../../..");
const here = import.meta.dirname;
const resultsDir = resolve(process.env["LINK_RESULTS"] ?? join(here, "results"));
const forgec = join(root, "target/debug/forgec");
const scratch: string[] = [];
const STRATEGIES = ["single", "per-entry-point"] as const;

function copyAcme(edit?: (app: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-t3-"));
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
  const links: Record<string, Link & { linkMs: number }> = {};
  for (const strategy of STRATEGIES) {
    const t0 = performance.now();
    const l = await link({ app, manifestDir: units, environment: join(app, "deploy/cloudflare/wrangler.jsonc"), strategy, out: join(app, "generated/linked", strategy) });
    links[strategy] = { ...l, linkMs: Math.round(performance.now() - t0) };
  }
  const appJson = JSON.parse(readFileSync(join(app, "generated/app.json"), "utf8")) as { buildHash: string };
  return { manifest: sealed.manifest, bySymbol: sealed.bySymbol, links, buildHash: appJson.buildHash };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { count: s.length, min: s[0] ?? 0, median: s[Math.floor(s.length / 2)] ?? 0, max: s.at(-1) ?? 0, total: s.reduce((n, x) => n + x, 0) };
};

function summarize(l: Link & { linkMs: number }) {
  const scripts = l.scripts.map((s) => ({
    name: s.name,
    members: s.members,
    raw: s.bytes!.raw,
    gzip: s.bytes!.gzip,
    composition: s.composition,
    appJson: { mode: s.slice.mode, bytes: s.slice.bytesSlice, ...(s.slice.fallbackReason ? { fallbackReason: s.slice.fallbackReason } : {}), resources: s.slice.resources.map((r) => r.split("/").pop()) },
    units: s.units.length,
    modules: s.modules.length,
    bindings: s.capabilities.injected.map((b) => b.name),
    unusedBindings: s.capabilities.unused.map((b) => b.name),
    dispatch: s.dispatch,
  }));
  const sliced = scripts.filter((s) => s.appJson.mode === "slice");
  return {
    strategy: l.strategy,
    linkMs: l.linkMs,
    scripts: l.scripts.length,
    router: l.router ? { raw: l.router.bytes!.raw, gzip: l.router.bytes!.gzip, routes: l.router.table.length } : null,
    raw: stats(scripts.map((s) => s.raw)),
    gzip: stats(scripts.map((s) => s.gzip)),
    deployRaw: scripts.reduce((n, s) => n + s.raw, 0) + (l.router?.bytes?.raw ?? 0),
    deployGzip: scripts.reduce((n, s) => n + s.gzip, 0) + (l.router?.bytes?.gzip ?? 0),
    appJsonSlice: { sliced: sliced.length, whole: scripts.filter((s) => s.appJson.mode === "whole").length, fallback: scripts.filter((s) => s.appJson.mode === "fallback").length, slicedBytes: stats(sliced.map((s) => s.appJson.bytes)) },
    warnings: [...new Set(l.scripts.flatMap((s) => s.capabilities.warnings))],
    perScript: scripts,
  };
}

/** What one edit re-uploads under each strategy: scripts whose bundle hash moved, against entry points whose closure hash moved. */
function editDiff(base: Awaited<ReturnType<typeof buildAndLink>>, edited: Awaited<ReturnType<typeof buildAndLink>>) {
  const closures = new Map(base.manifest.entryPoints.map((e) => [e.id, e.closureHash]));
  const closureMoved = edited.manifest.entryPoints.filter((e) => closures.get(e.id) !== e.closureHash).map((e) => e.id).sort();
  const unitsMoved = [...edited.bySymbol].filter(([s, h]) => base.bySymbol.get(s) !== h).map(([s]) => s).sort();
  const perStrategy = Object.fromEntries(
    STRATEGIES.map((strategy) => {
      const before = new Map(base.links[strategy]!.scripts.map((s) => [s.name, s]));
      const changed = edited.links[strategy]!.scripts.filter((s) => before.get(s.name)?.scriptHash !== s.scriptHash);
      const byClosure = changed.filter((s) => s.members.some((m) => closureMoved.includes(m)));
      const routerChanged = base.links[strategy]!.router?.scriptHash !== edited.links[strategy]!.router?.scriptHash;
      return [
        strategy,
        {
          scripts: edited.links[strategy]!.scripts.length,
          reuploaded: changed.length + (routerChanged ? 1 : 0),
          reuploadedRaw: changed.reduce((n, s) => n + s.bytes!.raw, 0),
          reuploadedGzip: changed.reduce((n, s) => n + s.bytes!.gzip, 0),
          becauseAClosureMoved: byClosure.map((s) => s.name),
          otherwise: changed.filter((s) => !byClosure.includes(s)).map((s) => ({ name: s.name, members: s.members.length > 3 ? `${s.members.length} members` : s.members, appJson: s.slice.mode })),
          routerChanged,
        },
      ];
    }),
  );
  return { manifestHashMoved: base.manifest.manifestHash !== edited.manifest.manifestHash, buildHashMoved: base.buildHash !== edited.buildHash, unitsMoved, closureHashMoved: closureMoved, perStrategy };
}

try {
  const base = await buildAndLink(copyAcme());
  const wholeDir = mkdtempSync(join(tmpdir(), "forge-t3-whole-"));
  scratch.push(wholeDir);
  const wholeApp = await bundleWholeApp(join(root, "examples/acme"), wholeDir);
  // wrangler's own measure of today's upload (its default build: not minified).
  const dry = mkdtempSync(join(tmpdir(), "forge-t3-dry-"));
  scratch.push(dry);
  const wrangler = join(root, "examples/acme/node_modules/.bin/wrangler");
  const dryLine = execFileSync(wrangler, ["deploy", "--dry-run", "--config", "deploy/cloudflare/wrangler.jsonc", "--outdir", dry], { cwd: join(root, "examples/acme"), env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, encoding: "utf8" })
    .split("\n")
    .find((l) => l.includes("Total Upload"))
    ?.trim();

  const sizes = {
    version: "t3-linker-packed-sizes/1",
    issue: "FORG-29",
    measured: {
      toolchain: { ...base.manifest.toolchain, node: process.version, linker: base.links["single"]!.linker },
      manifestHash: base.manifest.manifestHash,
      bundling: "esbuild, minified, format esm, platform neutral, conditions source/workerd/worker/browser/import, cloudflare:* and node:* external; gzip -9",
      wholeAppWorker: { ...wholeApp, source: "examples/acme/deploy/cloudflare/worker.ts", wranglerDryRun: dryLine ?? null },
      strategies: Object.fromEntries(STRATEGIES.map((s) => [s, summarize(base.links[s]!)])),
    },
  };
  writeFileSync(join(resultsDir, "sizes.json"), stableJson(sizes));

  // Edit 1: one unit's body (T2's edit). Edit 2: a documentation-only edit to a .forge declaration.
  const bodyEdit = await buildAndLink(
    copyAcme((app) => {
      const f = join(app, "impl/rebuild-order-summary.ts");
      const text = readFileSync(f, "utf8");
      if (!text.includes("{ rebuilt: true }")) throw new Error("edit target moved");
      writeFileSync(f, text.replace("{ rebuilt: true }", "{ rebuilt: false }"));
    }),
  );
  const docEdit = await buildAndLink(
    copyAcme((app) => {
      const f = join(app, "src/customers/customer.forge");
      const text = readFileSync(f, "utf8");
      if (!text.includes("/// A business that buys from Acme. Not the tenant.")) throw new Error("edit target moved");
      writeFileSync(f, text.replace("/// A business that buys from Acme. Not the tenant.", "/// A business that buys from Acme. Never the tenant."));
    }),
  );
  const edits = {
    version: "t3-linker-packed-edits/1",
    issue: "FORG-29",
    measured: {
      "impl body: impl/rebuild-order-summary.ts `{ rebuilt: true }` -> `{ rebuilt: false }`": editDiff(base, bodyEdit),
      "doc only: src/customers/customer.forge `///` comment on Customer": editDiff(base, docEdit),
    },
  };
  writeFileSync(join(resultsDir, "edits.json"), stableJson(edits));
  const pe = sizes.measured.strategies["per-entry-point"];
  console.log(JSON.stringify({ wholeApp: wholeApp.bytes, single: sizes.measured.strategies.single.raw, perEntryPoint: { scripts: pe.scripts, raw: pe.raw, gzip: pe.gzip } }));
  console.log(JSON.stringify(edits.measured, (k, v) => (k === "otherwise" || k === "becauseAClosureMoved" ? (Array.isArray(v) ? v.length : v) : v)));
} finally {
  scratch.forEach((d) => rmSync(d, { recursive: true, force: true }));
}
