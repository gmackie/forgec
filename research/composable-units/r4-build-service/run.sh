#!/usr/bin/env bash
# Local measurement of the FORG-50 build service. Run from the repository root with a clean tree (the
# Artifacts series builds HEAD's commit from git objects). Builds the native reference
# (`forgec build --units` + forge-units), the Worker (build.mjs), records sizes, serves the Worker with
# `wrangler dev --local` next to a fake Artifacts API, and runs measure.mjs. generated/ stays ignored.
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/r4-build-service
wrangler=packages/runtime/node_modules/.bin/wrangler
port="${PORT:-8851}"
fake_port="${FAKE_PORT:-8852}"
runs="${RUNS:-10}"
token="local-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
native=$(mktemp -d)
dry=$(mktemp -d)
set -m
trap 'rm -rf "$native" "$dry"; for p in ${server:-} ${fake:-}; do kill -- "-$p" 2>/dev/null || true; done' EXIT
git diff --quiet HEAD -- examples pnpm-lock.yaml tsconfig.base.json packages/runtime/package.json packages/contracts \
  || { echo "examples/ or the lockfile differ from HEAD: commit first, the Artifacts series builds HEAD" >&2; exit 1; }

cargo build --locked --release -p forgegraph-cli
target/release/forgec build examples/acme --units --out "$native"
node packages/units/src/cli.ts examples/acme --out "$native/units"

node "$here/build.mjs"
WRANGLER_SEND_METRICS=false "$wrangler" deploy --dry-run --config "$here/wrangler.jsonc" --outdir "$dry" 2>&1 \
  | grep -E "Total Upload|Worker Startup" > "$here/results/wrangler-dry-run.log" || true
node -e '
const fs=require("fs"),z=require("zlib"),p=require("path");
const f=(n)=>{const b=fs.readFileSync(p.join(process.argv[1],"generated",n));return {rawBytes:b.length,gzipBytes:z.gzipSync(b,{level:9}).length}};
const parts={"worker.mjs (worker + @forgegraph/units + TypeScript, minified)":f("worker.mjs"),"forgec.wasm (forgegraph-wasm, release)":f("forgec.wasm"),"esbuild.wasm (esbuild-wasm)":f("esbuild.wasm")};
const meta=JSON.parse(fs.readFileSync(p.join(process.argv[1],"generated/meta.json"),"utf8"));
const inputs=Object.entries(meta.outputs[Object.keys(meta.outputs)[0]].inputs).reduce((a,[k,v])=>{const g=k.includes("typescript/")?"typescript":k.includes("esbuild-wasm/")?"esbuild-wasm (JS)":k.includes("packages/units/")?"@forgegraph/units":"worker";a[g]=(a[g]||0)+v.bytesInOutput;return a},{});
const total=Object.values(parts).reduce((a,x)=>({rawBytes:a.rawBytes+x.rawBytes,gzipBytes:a.gzipBytes+x.gzipBytes}),{rawBytes:0,gzipBytes:0});
fs.writeFileSync(p.join(process.argv[1],"results/size.json"),JSON.stringify({parts,total,"worker.mjs bytes by input":inputs},null,2)+"\n")' "$here"

node "$here/fake-artifacts.mjs" "$fake_port" "$token" > "$here/results/fake-artifacts.log" 2>&1 &
fake=$!
WRANGLER_SEND_METRICS=false "$wrangler" dev --config "$here/wrangler.jsonc" --local --port "$port" \
  --var "ARTIFACTS_API_BASE:http://127.0.0.1:$fake_port" --var "ARTIFACTS_API_TOKEN:$token" --var "ARTIFACTS_ACCOUNT_ID:local" \
  > "$here/results/workerd.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do grep -q "Ready on" "$here/results/workerd.log" && break; sleep 1; done
grep -q "Ready on" "$here/results/workerd.log" || { cat "$here/results/workerd.log"; exit 1; }
# The workerd that wrangler started: same process group as the wrangler job (set -m), not another's.
workerd_pid=$(pgrep -g "$server" -f "workerd" | tail -1)
COMMIT=$(git rev-parse HEAD) FAKE_ARTIFACTS="http://127.0.0.1:$fake_port" WORKERD_PID="$workerd_pid" \
  node "$here/measure.mjs" "http://127.0.0.1:$port" "$native" "$runs" local
# wrangler prints var values: strip the per-run token from the log.
sed -i.bak "s/$token/<token>/g" "$here/results/workerd.log" && rm -f "$here/results/workerd.log.bak"
