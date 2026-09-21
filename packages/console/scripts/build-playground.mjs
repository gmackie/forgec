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
