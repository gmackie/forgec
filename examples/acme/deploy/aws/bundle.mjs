// Bundles the Lambda handler with esbuild (ESM, node24). The AWS SDK v3 is
// bundled too so the artifact is self-contained and versions are pinned.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
mkdirSync("deploy/aws/dist", { recursive: true });
await build({
  entryPoints: ["deploy/aws/handler.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["source"],
  outfile: "deploy/aws/dist/index.mjs",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  sourcemap: false,
  minify: false,
});
console.log("bundled deploy/aws/dist/index.mjs");
