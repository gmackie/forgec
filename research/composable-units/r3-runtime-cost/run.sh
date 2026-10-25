#!/usr/bin/env bash
# Run from the repository root. FORG-42: measure what linker A's per-script runtime costs and what the
# shared runtime Worker (strategy per-entry-point-shared) saves, then run the linker-A differential
# with the shared target added, writing everything to results/ (LINK_RESULTS).
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/r3-runtime-cost
t3=research/composable-units/t3-linker-packed
linked=examples/acme/generated/linked
cli=packages/linker-packed/src/cli.ts

cargo build --locked -p forgegraph-cli
pnpm --filter "@forgegraph/runtime^..." build
pnpm --filter @forgegraph/runtime build
pnpm --filter @acme/commerce-deploy units:build

# What Workers RPC lets a script hand the runtime Worker (results/rpc-probe.json).
node "$here/probe/run.mjs" "$here/results/rpc-probe.json" > /dev/null
# Sizes, deploy bytes, body-edit re-upload, Effect breakdown, RPC crossings, workerd latency (results/measure.json).
COLD_RUNS="${COLD_RUNS:-7}" WARM_RUNS="${WARM_RUNS:-100}" node "$here/measure.ts"

# Differential targets (as FORG-29/37), plus per-entry-point-shared, then the differential.
node "$t3/baseline.ts" examples/acme "$linked/whole-app"
node "$cli" examples/acme --strategy single
node "$cli" examples/acme --strategy per-entry-point
node "$cli" examples/acme --strategy per-entry-point --full-app-json --out "$linked/per-entry-point-full"
node "$cli" examples/acme --strategy per-entry-point-shared
T3_DIFFERENTIAL=1 LINK_RESULTS="$PWD/$here/results" pnpm --filter @forgegraph/linker-packed exec vitest run test/differential.test.ts
# RPC calls back into a script per request, over the suite (results/rpc-trace.json).
node --experimental-transform-types "$here/rpc-trace.ts" > /dev/null
