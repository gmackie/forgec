import { build } from "esbuild";
await build({
  entryPoints: ["src/node.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["source"],
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

await build({entryPoints:["src/runner/main.ts"],outfile:"dist/runner.mjs",bundle:true,platform:"node",target:"node22",format:"esm",conditions:["source"]});
