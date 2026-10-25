// Builds the build-service Worker into generated/: worker.mjs (this directory's worker.mjs with
// @forgegraph/units and TypeScript bundled in), forgec.wasm (forgegraph-wasm for wasm32) and
// esbuild.wasm (esbuild-wasm, the same esbuild version @forgegraph/units bundles with natively).
// Run from anywhere. FORGEC_WASM=<path> skips the cargo build.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(here, "../../..");
const units = join(root, "packages/units");
const require = createRequire(join(units, "package.json"));
const esbuild = require("esbuild");
const wasmPkg = JSON.parse(readFileSync(require.resolve("esbuild-wasm/package.json"), "utf8"));
if (wasmPkg.version !== esbuild.version) throw new Error(`esbuild-wasm ${wasmPkg.version} != esbuild ${esbuild.version}: the Worker would bundle with a different esbuild`);

const out = join(here, "generated");
mkdirSync(out, { recursive: true });
if (!process.env.FORGEC_WASM)
  execFileSync("cargo", ["build", "--locked", "-p", "forgegraph-wasm", "--target", "wasm32-unknown-unknown", "--release"], { cwd: root, stdio: "inherit" });
copyFileSync(process.env.FORGEC_WASM || join(root, "target/wasm32-unknown-unknown/release/forgegraph_wasm.wasm"), join(out, "forgec.wasm"));
copyFileSync(join(require.resolve("esbuild-wasm/package.json"), "../esbuild.wasm"), join(out, "esbuild.wasm"));

// TypeScript's CommonJS build probes for Node (process.nextTick plus `require`), which nodejs_compat
// would satisfy, and then requires fs/path/os at load. process.browser keeps it off that path:
// the sealer uses only its parser. The Node built-ins stay external and are never called.
const result = await esbuild.build({
  entryPoints: [join(here, "worker.mjs")],
  outfile: join(out, "worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import"],
  alias: { "esbuild-wasm": join(require.resolve("esbuild-wasm/package.json"), "../esm/browser.js") },
  external: ["*.wasm", "node:*", "fs", "path", "os", "crypto", "inspector", "perf_hooks", "source-map-support"],
  define: { "process.browser": "true" },
  minify: true,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});
writeFileSync(join(out, "meta.json"), JSON.stringify(result.metafile));
const size = (f) => readFileSync(join(out, f)).byteLength;
console.error(`generated/: worker.mjs ${size("worker.mjs")} B, forgec.wasm ${size("forgec.wasm")} B, esbuild.wasm ${size("esbuild.wasm")} B (esbuild ${esbuild.version})`);
