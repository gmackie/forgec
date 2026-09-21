import { execFileSync } from "node:child_process";
import { build } from "esbuild";
execFileSync(
  "cargo",
  [
    "run",
    "-q",
    "-p",
    "forgegraph-cli",
    "--",
    "build",
    "../../examples/console-playground",
    "--out",
    "generated/playground",
  ],
  { stdio: "inherit" },
);
await build({
  entryPoints: ["scripts/playground-runtime.ts"],
  outfile: "generated/playground/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["source"],
  banner: {
    js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);',
  },
});
await build({
  entryPoints: ["scripts/playground-worker.ts"],
  outfile: "generated/playground/worker.mjs",
  bundle: true,
  platform: "browser",
  external: ["node:*"],
  format: "esm",
  target: "es2022",
  conditions: ["source"],
  minify: true,
});
