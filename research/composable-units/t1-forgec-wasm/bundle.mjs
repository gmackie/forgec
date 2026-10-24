// Builds forgegraph-wasm for wasm32 and collects every file `forgec build examples/acme` reads.
// Run from the repository root. Output lands in the ignored generated/ directory.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(import.meta.dirname, "generated");
mkdirSync(out, { recursive: true });
if (!process.env.FORGEC_WASM)
  execFileSync(
    "cargo",
    ["build", "--locked", "-p", "forgegraph-wasm", "--target", "wasm32-unknown-unknown", "--release"],
    { cwd: root, stdio: "inherit" },
  );
copyFileSync(
  process.env.FORGEC_WASM || join(root, "target/wasm32-unknown-unknown/release/forgegraph_wasm.wasm"),
  join(out, "forgec.wasm"),
);

// The same set the CLI touches: manifests, lock, sources of acme and its path dependency, pinned extensions.
const files = {};
const add = (rel) => (files[rel] = readFileSync(join(root, rel), "utf8"));
const walk = (dir) => {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (entry.name.endsWith(".forge")) add(rel);
  }
};
for (const rel of [
  "examples/acme/forge.toml",
  "examples/acme/forge.lock",
  "examples/payments/forge.toml",
  "packages/contracts/capability-manifest/manifests/d1.json",
  "packages/contracts/capability-manifest/manifests/dynamodb.json",
])
  add(rel);
walk("examples/acme/src");
walk("examples/payments/src");
const request = { root: "examples/acme", files: Object.fromEntries(Object.entries(files).sort()) };
writeFileSync(join(out, "acme-request.json"), JSON.stringify(request));
console.error(`${relative(root, out)}: forgec.wasm, acme-request.json (${Object.keys(files).length} files)`);
