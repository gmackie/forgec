#!/usr/bin/env bash
# Run from the repository root. Seals acme's Closure Manifest, links it with every strategy, measures
# sizes and edit re-uploads, then serves each target in workerd (Miniflare) and runs the conformance
# scenarios against it (linker differential). Generated output stays under examples/acme/generated/.
set -euo pipefail
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw new Error("Node 24+ required")'
here=research/composable-units/t3-linker-packed
linked=examples/acme/generated/linked
cli=packages/linker-packed/src/cli.ts

cargo build --locked -p forgegraph-cli
# The linker builds the runtime Model at link time to refuse slices the runtime would reject; Node
# loads the runtime from dist.
pnpm --filter "@forgegraph/runtime^..." build
pnpm --filter @forgegraph/runtime build
pnpm --filter @acme/commerce-deploy units:build

node "$here/baseline.ts" examples/acme "$linked/whole-app"
node "$cli" examples/acme --strategy single
node "$cli" examples/acme --strategy per-entry-point
# Control: the same split with the whole app.json in every script, to tell splitting from slicing.
node "$cli" examples/acme --strategy per-entry-point --full-app-json --out "$linked/per-entry-point-full"

node "$here/measure.ts"
T3_DIFFERENTIAL=1 pnpm --filter @forgegraph/linker-packed exec vitest run test/differential.test.ts
