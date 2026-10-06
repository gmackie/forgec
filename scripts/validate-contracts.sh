#!/usr/bin/env bash
# Build every package in the repository (examples, examples/next, foundation packages and apps)
# into a temporary directory and validate each `contract.json` with ForgeGraph's own
# validateContract (vendored in conformance/contract-ir). Nothing is committed; the curated
# fixtures in conformance/fixtures/contract-ir are the checked-in subset.
# Needs `pnpm install` (zod) and a Rust toolchain. Exit 1 on any build or validation failure.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -q -p forgegraph-cli
forgec="$PWD/target/debug/forgec"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/contracts"

packages=0
build_failures=0
for dir in examples/*/ examples/next/*/ examples/foundation/apps/*/ packages/foundation/*/; do
  # a package has a [package] table (examples/next/forge.toml is a [workspace])
  grep -qs '^\[package\]' "$dir/forge.toml" || continue
  packages=$((packages + 1))
  slug=$(echo "${dir%/}" | tr '/' '_')
  if ! "$forgec" build "$dir" --out "$work/out" >/dev/null 2>"$work/err" || [[ ! -f "$work/out/contract.json" ]]; then
    build_failures=$((build_failures + 1))
    echo "FAIL ${dir%/}: no contract.json"
    grep -E "error|W-CONTRACT" "$work/err" | head -5 || true
  else
    cp "$work/out/contract.json" "$work/contracts/$slug.json"
  fi
  rm -rf "$work/out"
done

echo "built $packages packages ($build_failures without a contract)"
status=0
node --import ./conformance/contract-ir/ts-resolve.mjs --experimental-strip-types \
  conformance/contract-ir/validate.ts --summary "$work"/contracts/*.json || status=$?
if [[ $build_failures -gt 0 || $status -ne 0 ]]; then
  exit 1
fi
