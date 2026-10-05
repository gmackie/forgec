#!/usr/bin/env bash
# Run from the compiler/runtime repository root. Generated output remains ignored.
set -euo pipefail
: "${CF_FORGE_ROOT:?Set CF_FORGE_ROOT to an isolated checkout of Cloudflare Forge cfe397c296a5}"
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
root=research/cf-forge
loader="$CF_FORGE_ROOT/node_modules/tsx/dist/loader.mjs"
mkdir -p "$root/.cache" "$root/results"
python3 - <<'PY'
import hashlib,json,os
from pathlib import Path
root=Path('research/cf-forge'); baseline=json.loads((root/'baseline.json').read_text())
for p,h in baseline['forgegraph']['hashes'].items():
 assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h, 'compiler/runtime baseline changed: '+p
for p,h in baseline['cloudflareForge']['hashes'].items():
 assert hashlib.sha256((Path(os.environ['CF_FORGE_ROOT'])/p).read_bytes()).hexdigest()==h, 'upstream baseline changed: '+p
for f in json.loads((root/'fixtures/provenance.json').read_text()):
 assert hashlib.sha256((root/'fixtures'/(f['name']+'.json')).read_bytes()).hexdigest()==f['fixtureSha256']
PY
cargo build --locked -p forgegraph-cli
python3 "$root/import-probes.py"
python3 "$root/schema-corpus.py"
node --import "$loader" "$root/core-probes.mjs"
node --conditions=source --import "$loader" "$root/runtime-probes.mjs"
# Source packaging requires a full release artifact even when generating a small API.
if [[ ! -f "$root/.cache/cloudflare.json" ]]; then
 curl --fail --location --silent 'https://github.com/cloudflare/forge/releases/download/openapi%40e934edf0cddfc816c0a06cec0fabbff479424a1a/openapi.forge.json' -o "$root/.cache/cloudflare.json"
fi
python3 - <<'PY'
import json,hashlib
from pathlib import Path
p=Path('research/cf-forge');f=json.loads((p/'fixtures/provenance.json').read_text())[0]
assert hashlib.sha256((p/'.cache/cloudflare.json').read_bytes()).hexdigest()==f['sourceSha256']
PY
cp "$root/.cache/cloudflare.json" "$CF_FORGE_ROOT/openapi.json"
cp "$root/.cache/cloudflare.json" "$CF_FORGE_ROOT/packages/cloudflare-fern-config/fern/openapi.json"
(cd "$CF_FORGE_ROOT" && pnpm --filter @cloudflare/forge-transformer-sdk-ts build)
cli="$CF_FORGE_ROOT/packages/cloudflare-forge-transformer-sdk-ts/dist/cli.js"
for vendor in github cloudflare; do
 node "$cli" "$root/fixtures/$vendor.json" --out "$root/.cache/$vendor-sdk"
done
node "$cli" "$root/fixtures/github.json" --out "$root/.cache/github-sdk-repeat"
python3 "$root/evolution-probe.py"
node "$cli" "$root/.cache/github-next.json" --out "$root/.cache/github-next-sdk"
node --conditions=source --import "$loader" --test "$root/bindings.test.mjs"
python3 "$root/check-artifacts.py"
