# Getting started

## Install the compiler

```sh
brew install gmacko/tap/forgec     # macOS and Linux
cargo install forgegraph-cli       # from source; needs Rust 1.97+
forgec --version
```

Prebuilt binaries with SHA-256 checksums are attached to every
[release](https://github.com/gmackie/forgegraph/releases).

## Toolchain for working on ForgeGraph itself

- Rust 1.97+ (`cargo`), Node 22.5+, pnpm 10.
- `cargo build -p forgegraph-cli` builds the compiler; the binary is
  `target/debug/forgec` (`cargo run -q -p forgegraph-cli -- <cmd>` works
  without installing).
- `pnpm install` installs the TypeScript workspace (runtime, React workspace, conformance, examples).

Every `forgec` command below also works as
`cargo run -q -p forgegraph-cli -- <cmd>` from a source checkout.

## Compile the reference application

```
forgec check examples/acme      # parse, resolve, check, verify forge.lock
forgec fmt --check examples/acme
forgec build examples/acme      # writes examples/acme/generated/{app.json, d1/0001_init.sql, client.ts}
```

`app.json` is the app bundle: the DomainIR plus every target-independent plan
(contracts, UI descriptor, messaging, workflows, schedules, realtime,
observability) and the physical plans (SQLite schema, DynamoDB keys). Both hosts
load the same bundle.

## Run it locally on Cloudflare (Workers + D1 + Workflows + Durable Objects)

```
cd examples/acme
pnpm cf:migrate:local --persist-to .wrangler/state
pnpm exec wrangler dev --config deploy/cloudflare/wrangler.jsonc --port 8797 --persist-to .wrangler/state
curl -s http://127.0.0.1:8797/v1/customers -H 'x-forge-tenant: demo' -H 'x-forge-actor: me' \
  -H 'content-type: application/json' -d '{"code":"ACME","name":"Acme"}'
```

`FORGE_AUTH=dev-headers` (in `wrangler.jsonc` vars / `.dev.vars`) trusts the
`x-forge-tenant` / `x-forge-actor` headers, which is why the example is
configured that way and why it prints a warning on every start. Every host
refuses to start with no `AuthHost` at all — there is no silent fallback. A
deployment supplies a real one:

```ts
createNodeHost({ bundle, auth: jwtAuth({ issuer, audience, secret, claims }) });
```

Before deploying `examples/acme` anywhere reachable, replace the placeholder
`database_id` in `deploy/cloudflare/wrangler.jsonc` with your own D1 database
and drop `FORGE_AUTH` from its vars.

## Run it on AWS

```
cd examples/acme
pnpm aws:deploy          # esbuild bundle + CDK deploy; prints ApiUrl and RealtimeUrl
```

## Use the generated client

```ts
import { createClient } from "./generated/client";
const c = createClient({ baseUrl, tenant: "demo", actor: "me" });
const customer = await c.customers.create({ code: "ACME", name: "Acme" });
const page = await c.orders.listByCustomer({ customer: customer.id }, { limit: 20 });
await c.functions.submitOrder({ order: page.items[0].id, expectedVersion: 1 });
const run = await c.workflows.processOrder.start({ order: ..., expectedVersion: 1 });
```

The same client talks to either deployment; only `baseUrl` changes.

## Run the conformance suite

```
cd conformance
pnpm test                                                    # reference model, golden vectors, migration drift
FORGE_TARGET_URL=https://... FORGE_TARGET_NAME=cloudflare-d1 pnpm exec vitest run test/remote.test.ts
```

See [conformance.md](conformance.md) for the full certification run.

## Editor support

`forgec lsp` is a stdio language server (diagnostics with suggestions on open and
change, canonical formatting). Point any LSP client at it for `.forge` files.
