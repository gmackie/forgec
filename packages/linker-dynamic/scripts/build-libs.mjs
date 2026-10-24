#!/usr/bin/env node
// Builds the shared libraries the linker provides to every child, as content-addressed blobs:
//   effect                -> `export * from "effect"`, one ESM module
//   @forgegraph/runtime   -> the runtime surface a child needs (createWorker for the Cloudflare
//                            host, defineFunction for the forgegraph-function/1 ABI), with Effect
//                            left as an import of the `effect` module above so units and runtime
//                            share one Effect instance.
// Writes generated/libs/<name>@<version>.js and generated/libs/libs.json. Run from anywhere.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(here, "generated/libs");
mkdirSync(out, { recursive: true });
const version = (name) => JSON.parse(readFileSync(join(here, "node_modules", name, "package.json"), "utf8")).version;

const common = {
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  // `source` resolves workspace packages to src/, as the runtime's own Worker builds do.
  conditions: ["source", "workerd", "worker", "import"],
  minify: true,
  legalComments: "none",
  charset: "utf8",
  logLevel: "silent",
  metafile: true,
  absWorkingDir: here,
};

// The runtime module is named "@forgegraph/runtime", so its bare "effect" would resolve to
// "@forgegraph/effect"; point it at the root "effect" module instead.
const effectAtRoot = {
  name: "effect-at-root",
  setup(b) {
    b.onResolve({ filter: /^effect$/ }, () => ({ path: "../effect", external: true }));
    // Server-only code the runtime's root entry reaches; tree-shaken from what a child uses.
    b.onResolve({ filter: /^(node:|@aws-sdk\/|pg$|ws$)/ }, (a) => ({ path: a.path, external: true }));
  },
};

const libs = {};
const emit = async (name, ver, options) => {
  const r = await build({ ...common, ...options });
  const code = r.outputFiles[0].contents;
  const imports = Object.values(r.metafile.outputs)[0].imports.filter((i) => i.external).map((i) => i.path);
  // workerd provides node:crypto at the pinned compatibility date without nodejs_compat (probed).
  const unexpected = imports.filter((p) => p !== "../effect" && p !== "node:crypto");
  if (unexpected.length) throw new Error(`${name}: unresolved imports left in the library: ${unexpected.join(", ")}`);
  const digest = `sha256:${createHash("sha256").update(code).digest("hex")}`;
  const file = `${name.replace("/", "+")}@${ver}.js`;
  writeFileSync(join(out, file), code);
  libs[`${name}@${ver}`] = { digest, file, bytes: code.byteLength };
};

// The Effect surface a child gets: the namespaces the runtime library imports plus `Effect`, which
// the forgegraph-function/1 ABI needs. `export * from "effect"` is 4x larger (README); a unit that
// imports anything else fails to load, which is the fail-closed outcome.
export const EFFECT_SURFACE = ["Cause", "Context", "Data", "Effect", "Layer"];
await emit("effect", version("effect"), { stdin: { contents: `export { ${EFFECT_SURFACE.join(", ")} } from "effect";\n`, resolveDir: here, sourcefile: "effect-lib.js", loader: "js" } });
await emit("@forgegraph/runtime", version("@forgegraph/runtime"), {
  stdin: {
    contents: `export { defineFunction } from "@forgegraph/runtime";\nexport { createWorker } from "@forgegraph/runtime/cloudflare";\n`,
    resolveDir: here,
    sourcefile: "runtime-lib.js",
    loader: "js",
  },
  plugins: [effectAtRoot],
});
const runtimeCode = readFileSync(join(out, libs[`@forgegraph/runtime@${version("@forgegraph/runtime")}`].file), "utf8");
const used = new Set([...runtimeCode.matchAll(/import\{([^}]*)\}from"\.\.\/effect"/g)].flatMap((m) => m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0])));
const outside = [...used].filter((n) => !EFFECT_SURFACE.includes(n));
if (outside.length) throw new Error(`the runtime library imports Effect names outside EFFECT_SURFACE: ${outside.join(", ")}`);
writeFileSync(join(out, "libs.json"), `${JSON.stringify(libs, null, 2)}\n`);
for (const [k, v] of Object.entries(libs)) console.log(`${k}: ${v.bytes} B ${v.digest}`);
