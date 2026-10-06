#!/usr/bin/env bash
# Refresh the vendored ForgeGraph contract IR validator from a ForgeGraph checkout.
# Usage: conformance/contract-ir/vendor.sh <forgegraph-checkout> [ref]   (ref defaults to origin/main)
set -euo pipefail
src=${1:?usage: vendor.sh <forgegraph-checkout> [ref]}
ref=${2:-origin/main}
sha=$(git -C "$src" rev-parse "$ref")
dest="$(dirname "$0")/vendor"
mkdir -p "$dest/ir"
for f in canonical.ts sla.ts ir/index.ts; do
  {
    printf '// Vendored verbatim from ForgeGraph packages/contract/src/%s\n' "$f"
    printf '// at commit %s (git.forgegraf.com/gmackie/forgegraph).\n' "$sha"
    printf '// Do not edit; refresh with conformance/contract-ir/vendor.sh.\n'
    git -C "$src" show "$sha:packages/contract/src/$f"
  } > "$dest/$f"
done
echo "vendored @forgegraph/contract IR at $sha"
