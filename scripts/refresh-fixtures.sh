#!/usr/bin/env bash
# Rebuild the reference app and copy its bundle into the conformance fixtures.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo run -q -p forge-cli -- build examples/acme
cp examples/acme/generated/app.json conformance/fixtures/acme.app.json
cp examples/acme/generated/client.ts conformance/fixtures/acme.client.ts
cp examples/acme/generated/d1/0001_init.sql conformance/fixtures/acme.0001_init.sql
echo "fixtures refreshed"
cargo run -q -p forge-cli -- build examples/next/education --out /tmp/forge-edu-gen >/dev/null && cp /tmp/forge-edu-gen/app.json conformance/fixtures/education.app.json
cargo run -q -p forge-cli -- build examples/next/acme-next --out /tmp/forge-acme-next-gen >/dev/null && cp /tmp/forge-acme-next-gen/app.json conformance/fixtures/acme-next.app.json && cp /tmp/forge-acme-next-gen/d1/0001_init.sql conformance/fixtures/acme-next.0001_init.sql
