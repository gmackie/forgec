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
  if [[ -f "packages/foundation/$foundation_slug/fixtures/controller/forge.toml" ]]; then
    cargo run -q -p forgegraph-cli -- build "packages/foundation/$foundation_slug/fixtures/controller" --out "conformance/fixtures/$foundation_slug-controller"
  fi
done

# Reserved SQL table and reference names must execute on both SQL adapters.
cargo run -q -p forgegraph-cli -- build examples/sql-identifiers --out conformance/fixtures/sql-identifiers

# Required self-references: `$self` on create and dependency-ordered import (#200).
cargo run -q -p forgegraph-cli -- build examples/self-reference --out conformance/fixtures/self-reference

feature_out=$(mktemp -d)
trap 'rm -rf "$foundation_out" "$feature_out"' EXIT
for feature_slug in collections credentials search issue-numbers project-portfolio deployment-lanes; do
  cargo run -q -p forgegraph-cli -- build "examples/$feature_slug" --out "$feature_out" >/dev/null
  cp "$feature_out/app.json" "conformance/fixtures/$feature_slug/app.json"
  mkdir -p "conformance/fixtures/$feature_slug/d1" "conformance/fixtures/$feature_slug/postgres"
  cp "$feature_out/d1/0001_init.sql" "conformance/fixtures/$feature_slug/d1/0001_init.sql"
  cp "$feature_out/postgres/0001_init.sql" "conformance/fixtures/$feature_slug/postgres/0001_init.sql"
done

# Contract IR (ForgeGraph's registry format): a curated set covering the emitter's features
# (@crud routes, lifecycle actions, functions, workflows, SLO classes, dependencies), validated by
# conformance/test/contract-ir.test.ts. Every other package is swept by scripts/validate-contracts.sh.
contract_ir_fixtures=(
  examples/studio-desk
  examples/console-playground
  examples/acme
  packages/foundation/billing
)
mkdir -p conformance/fixtures/contract-ir
for contract_source in "${contract_ir_fixtures[@]}"; do
  cargo run -q -p forgegraph-cli -- build "$contract_source" --out "$feature_out" >/dev/null
  cp "$feature_out/contract.json" "conformance/fixtures/contract-ir/$(basename "$contract_source").contract.json"
done
