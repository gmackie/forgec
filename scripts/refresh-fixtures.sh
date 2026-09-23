#!/usr/bin/env bash
# Rebuild the reference app and copy its bundle into the conformance fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo run -q -p forgegraph-cli -- build examples/acme
cp examples/acme/generated/app.json conformance/fixtures/acme.app.json
cp examples/acme/generated/client.ts conformance/fixtures/acme.client.ts
cp examples/acme/generated/d1/0001_init.sql conformance/fixtures/acme.0001_init.sql
echo "fixtures refreshed"
cargo run -q -p forgegraph-cli -- build examples/next/education --out /tmp/forge-edu-gen >/dev/null && cp /tmp/forge-edu-gen/app.json conformance/fixtures/education.app.json
cargo run -q -p forgegraph-cli -- build examples/next/acme-next --out /tmp/forge-acme-next-gen >/dev/null && cp /tmp/forge-acme-next-gen/app.json conformance/fixtures/acme-next.app.json && cp /tmp/forge-acme-next-gen/d1/0001_init.sql conformance/fixtures/acme-next.0001_init.sql

# Explicit package deployment probe, used by the ordinary runtime suite.
foundation_out=$(mktemp -d)
trap 'rm -rf "$foundation_out"' EXIT
cargo run -q -p forgegraph-cli -- build conformance/foundation/fixtures/composition/app --out "$foundation_out" >/dev/null
cp "$foundation_out/app.json" conformance/foundation/composition.app.json

# Foundation acceptance fixtures and their typed consumers must track compiler output.
for foundation_verifier in packages/foundation/*/verification.json; do
  foundation_slug=$(basename "$(dirname "$foundation_verifier")")
  cargo run -q -p forgegraph-cli -- build "packages/foundation/$foundation_slug" --out "conformance/fixtures/$foundation_slug"
  cargo run -q -p forgegraph-cli -- build "packages/foundation/$foundation_slug/fixtures/consumer" --out "conformance/fixtures/$foundation_slug-consumer"
done
