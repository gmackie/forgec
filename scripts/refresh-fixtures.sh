#!/usr/bin/env bash
# Rebuild the reference app and copy its bundle into the conformance fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo run -q -p forge-cli -- build examples/acme
cp examples/acme/generated/app.json conformance/fixtures/acme.app.json
cp examples/acme/generated/client.ts conformance/fixtures/acme.client.ts
cp examples/acme/generated/d1/0001_init.sql conformance/fixtures/acme.0001_init.sql
echo "fixtures refreshed"
