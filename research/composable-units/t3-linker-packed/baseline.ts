// Today's whole-app Worker (examples/acme/deploy/cloudflare/worker.ts), bundled with the linker's
// esbuild settings so sizes and behaviour compare like for like. Writes <out>/worker.js.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "../../..");
const { build } = createRequire(join(root, "packages/linker-packed/package.json"))("esbuild") as typeof import("esbuild");

export async function bundleWholeApp(app: string, out: string) {
  const result = await build({
    entryPoints: [join(app, "deploy/cloudflare/worker.ts")], absWorkingDir: app, bundle: true, write: false, metafile: true, format: "esm", platform: "neutral", target: "es2022",
    mainFields: ["module", "main"], conditions: ["source", "workerd", "worker", "browser", "import"], external: ["cloudflare:*", "node:*"], minify: true, legalComments: "none", charset: "utf8", logLevel: "silent",
  });
  const code = result.outputFiles[0]!.contents;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "worker.js"), code);
  const inputs = Object.values(result.metafile.outputs)[0]!.inputs;
  const share = (re: RegExp) => Object.entries(inputs).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v.bytesInOutput, 0);
  return {
    bytes: { raw: code.byteLength, gzip: gzipSync(code, { level: 9 }).byteLength },
    composition: { effect: share(/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?effect\//), runtime: share(/packages\/runtime\//), "app.json": share(/generated\/app\.json$/), impl: share(/^impl\//) },
  };
}

if (import.meta.main) console.log(JSON.stringify(await bundleWholeApp(resolve(process.argv[2]!), resolve(process.argv[3]!))));
