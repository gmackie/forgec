#!/usr/bin/env bash
# Run from the repository root. Builds forgec natively and for wasm32, serves the Worker with
# wrangler dev --local, and writes results/. Generated output remains ignored.
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/t1-forgec-wasm
wrangler=packages/runtime/node_modules/.bin/wrangler
port="${PORT:-8811}"
runs="${RUNS:-10}"
native=$(mktemp -d)
dry=$(mktemp -d)
# wrangler leaves workerd running if only the node parent is killed; stop the whole group.
set -m
trap 'rm -rf "$native" "$dry"; [[ -n "${server:-}" ]] && kill -- "-$server" 2>/dev/null || true' EXIT

# Native reference output for the byte-for-byte comparison.
cargo build --locked --release -p forgegraph-cli
target/release/forgec check examples/acme
target/release/forgec build examples/acme --out "$native"

node "$here/bundle.mjs"
# wrangler's own measure of the upload it would send (worker.mjs + forgec.wasm + acme sources).
WRANGLER_SEND_METRICS=false "$wrangler" deploy --dry-run --config "$here/wrangler.jsonc" --outdir "$dry" 2>&1 \
  | grep "Total Upload" > "$here/results/wrangler-dry-run.log"

# Size of a size-tuned build, without changing the workspace release profile.
CARGO_TARGET_DIR=target/t1-size CARGO_PROFILE_RELEASE_OPT_LEVEL=z CARGO_PROFILE_RELEASE_LTO=true \
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_PROFILE_RELEASE_PANIC=abort \
  cargo build --locked -p forgegraph-wasm --target wasm32-unknown-unknown --release
node -e '
const fs=require("fs"),z=require("zlib");
const f=(p)=>{const b=fs.readFileSync(p);return {rawBytes:b.length,gzipBytes:z.gzipSync(b,{level:9}).length}};
fs.writeFileSync(process.argv[1],JSON.stringify({
  "release (workspace default profile)":f("target/wasm32-unknown-unknown/release/forgegraph_wasm.wasm"),
  "release opt-level=z lto=true codegen-units=1 panic=abort (env override, not committed)":f("target/t1-size/wasm32-unknown-unknown/release/forgegraph_wasm.wasm"),
  "wasm-opt":null,
  note:"wasm-opt (binaryen) was not installed on the measuring machine; its effect is not measured"
},null,2)+"\n")' "$here/results/size-variants.json"

# One server; measure.mjs sends the first request it ever receives and reports it separately.
WRANGLER_SEND_METRICS=false "$wrangler" dev --config "$here/wrangler.jsonc" --local --port "$port" \
  > "$here/results/workerd.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do
  grep -q "Ready on" "$here/results/workerd.log" && break
  sleep 1
done
grep -q "Ready on" "$here/results/workerd.log" || { cat "$here/results/workerd.log"; exit 1; }
WRANGLER_VERSION=$("$wrangler" --version | tail -1) node "$here/measure.mjs" "http://127.0.0.1:$port" "$native" "$runs"
