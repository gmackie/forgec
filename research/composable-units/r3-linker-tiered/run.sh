#!/usr/bin/env bash
# FORG-43. Run from the repository root after `pnpm install --frozen-lockfile`.
# 1. Build forgec, the runtime, acme's sealed manifest and linker B's libraries.
# 2. Link the differential's targets: today's whole-app Worker, linker A (per-entry-point) and linker C (tiered).
#    Linker B's host is bundled by the differential itself.
# 3. The differential (results/conformance.json), then the swap and fallback demonstration and the
#    local latency numbers (results/swap.json, results/latency.json).
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/r3-linker-tiered
linked=examples/acme/generated/linked

cargo build --locked -p forgegraph-cli
pnpm --filter "@forgegraph/linker-tiered^..." run build
pnpm --filter @acme/commerce-deploy units:build

node research/composable-units/t3-linker-packed/baseline.ts examples/acme "$linked/whole-app"
node packages/linker-packed/src/cli.ts examples/acme --strategy per-entry-point
node packages/linker-tiered/src/cli.ts examples/acme

TIERED_DIFFERENTIAL=1 LINK_RESULTS="$PWD/$here/results" pnpm --filter @forgegraph/linker-tiered exec vitest run test/differential.test.ts
node "$here/measure.ts"
