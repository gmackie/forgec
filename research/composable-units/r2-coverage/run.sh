#!/usr/bin/env bash
# FORG-33. Run from the repository root after `pnpm install --frozen-lockfile` and `pnpm -r run build`.
# 1. Coverage before/after and every unit's source spans checked against the working tree.
# 2. Linker A: T3's run (link every strategy, sizes, edit re-uploads, the workerd differential),
#    writing into results/linker-packed so T3's own record stays as it was measured.
# 3. Linker B: T4's conformance differential (whole-app, strict, reported fallback).
set -euo pipefail
here=research/composable-units/r2-coverage
mkdir -p "$here/results/linker-packed"
cargo build --locked -p forgegraph-cli
node "$here/measure.ts"
LINK_RESULTS="$PWD/$here/results/linker-packed" bash research/composable-units/t3-linker-packed/run.sh
node "$here/conformance-dynamic.ts"
