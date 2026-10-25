#!/usr/bin/env node
// FORG-48: builds one loader-miss lab Worker into dist/<target>/ (worker.js + wrangler.jsonc). ForgeGraph's
// deploy agent runs it as the target's buildCommand from this directory, after `pnpm install
// --frozen-lockfile` at the repository root; the deployCommand uploads dist/<target>/wrangler.jsonc with the
// pinned wrangler under the target's workerName. Same shape as ../r4-deployed/build.mjs's linker-b target.
//
//   node build.mjs <miss-base|miss-b|miss-smart>        LAB_PLACEMENT='{"mode":"smart","hint":"enam"}' for miss-smart
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { D1, R2, SECRETS, WORKERS } from "./lab/names.mjs";

const here = import.meta.dirname;
const root = resolve(here, "../../..");
const { build } = createRequire(join(root, "packages/linker-dynamic/package.json"))("esbuild");
const target = process.argv[2];
if (!target || !WORKERS[target]) throw new Error(`usage: build.mjs <${Object.keys(WORKERS).join("|")}>`);
const out = join(here, "dist", target);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const r = await build({
  entryPoints: [join(here, "lab/linker-b.js")],
  absWorkingDir: root,
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["source", "workerd", "worker", "browser", "import"],
  external: ["cloudflare:*", "node:*"],
  minify: true,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});
writeFileSync(join(out, "worker.js"), r.outputFiles[0].contents);

// FORG-38's ForgeGraph gap 4: the agent stamps FG_COMMIT_HASH only into a config in appDir, so the build does it.
const source = { FG_APP: "forge-console", FG_COMMIT_HASH: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
const vars = { FORGE_AUTH: "dev-headers", FORGE_CORS: "http://localhost:5173", ...(target === "miss-base" ? { LINKER_UNIT_CACHE: "off" } : {}), ...source };
const config = {
  name: WORKERS[target],
  main: "worker.js",
  observability: { enabled: true, head_sampling_rate: 1 },
  no_bundle: true,
  compatibility_date: "2026-09-25",
  workers_dev: true,
  worker_loaders: [{ binding: "LOADER" }],
  // miss-smart's placement: LAB_PLACEMENT (JSON, set in the target's buildCommand), default Smart Placement.
  ...(target === "miss-smart" ? { placement: JSON.parse(process.env.LAB_PLACEMENT ?? '{"mode":"smart"}') } : {}),
  r2_buckets: [{ binding: "UNITS", bucket_name: R2[target] }],
  d1_databases: [{ binding: "DB", database_name: D1.acme }],
  vars,
  "//secrets": Object.values(SECRETS),
};
writeFileSync(join(out, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
console.log(`forg48 lab: built ${target} (${WORKERS[target]}) -> ${relative(root, out)} (worker.js ${readFileSync(join(out, "worker.js")).byteLength} B)`);
