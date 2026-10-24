#!/usr/bin/env bash
# Run from the repository root. FORG-37: measure linker A's per-entry-point output for examples/acme
# with the runtime split by feature, then run the linker differential (conformance in workerd).
#   label: results/<label>.json (default "after"; "before" and "main-c0e7558" were measured with this
#   script on main bfee5b2 and c0e7558, without the split)
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/r2-runtime-split
t3=research/composable-units/t3-linker-packed
linked=examples/acme/generated/linked
cli=packages/linker-packed/src/cli.ts

cargo build --locked -p forgegraph-cli
pnpm --filter "@forgegraph/runtime^..." build
pnpm --filter @forgegraph/runtime build
pnpm --filter @acme/commerce-deploy units:build

node "$here/measure.ts" "${1:-after}"
node "$here/compare.ts"

# Differential targets (as FORG-29's run.sh), then the differential, written here (LINK_RESULTS).
node "$t3/baseline.ts" examples/acme "$linked/whole-app"
node "$cli" examples/acme --strategy single
node "$cli" examples/acme --strategy per-entry-point
node "$cli" examples/acme --strategy per-entry-point --full-app-json --out "$linked/per-entry-point-full"
T3_DIFFERENTIAL=1 LINK_RESULTS="$PWD/$here/results" pnpm --filter @forgegraph/linker-packed exec vitest run test/differential.test.ts
