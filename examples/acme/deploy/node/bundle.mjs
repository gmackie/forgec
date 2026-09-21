// Bundles the Node server with esbuild (ESM, node22): one self-contained artifact for
// Docker/Nix/systemd packaging (plan §5.4); `pg` stays external (native optional deps).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
mkdirSync("deploy/node/dist", { recursive: true });
await build({
  entryPoints: ["deploy/node/server.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["source"],
  external: ["pg", "pg-native", "ws"],
  outfile: "deploy/node/dist/server.mjs",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  sourcemap: false,
});
console.log("bundled deploy/node/dist/server.mjs");
