#!/usr/bin/env bash
# Run from the repository root. FORG-49: re-measure linker A's per-entry-point-shared after replacing
# FORG-42's call budget with a depth guard and sharing queue consumers, crons and workflow start and
# signal routes again; then run the linker-A differential with results here (LINK_RESULTS), and trace
# every shared request's depth and calls. Everything is local; nothing is deployed.
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/r4-depth-guard
t3=research/composable-units/t3-linker-packed
linked=examples/acme/generated/linked
cli=packages/linker-packed/src/cli.ts

cargo build --locked -p forgegraph-cli
pnpm --filter "@forgegraph/runtime^..." build
pnpm --filter @forgegraph/runtime build
pnpm --filter @acme/commerce-deploy units:build

# Sizes, deploy bytes and the one-body-edit re-upload (results/measure.json). results/before.json is
# the same script run on main 6b30f4d, before this change.
node "$here/measure.ts" results/measure.json

# Differential targets (as FORG-29/37/42), then the differential.
node "$t3/baseline.ts" examples/acme "$linked/whole-app"
node "$cli" examples/acme --strategy single
node "$cli" examples/acme --strategy per-entry-point
node "$cli" examples/acme --strategy per-entry-point --full-app-json --out "$linked/per-entry-point-full"
node "$cli" examples/acme --strategy per-entry-point-shared
T3_DIFFERENTIAL=1 LINK_RESULTS="$PWD/$here/results" pnpm --filter @forgegraph/linker-packed exec vitest run test/differential.test.ts
# Depth and calls per shared request, over the suite (results/trace.json).
node --experimental-transform-types "$here/trace.ts" > /dev/null
