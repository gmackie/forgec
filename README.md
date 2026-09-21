# ForgeGraph

**One package. Equivalent behaviour on Cloudflare, AWS and Node.**

ForgeGraph is a compiler and an application runtime. You describe your domain
once in a `.forge` package — resources, functions, workflows, channels,
policies, data classifications — and write the behaviour once as ordinary
[Effect](https://effect.website) code. The compiler produces a deployment plan
for each target it supports, and the runtime executes that plan with the same
observable semantics everywhere:

| | Cloudflare | AWS | Node / self-hosted |
| --- | --- | --- | --- |
| compute | Workers | Lambda + HTTP API | Node 22+ HTTP server |
| data | D1 | DynamoDB | PostgreSQL, SQLite, libsql |
| blobs | R2 | S3 | filesystem / S3-compatible |
| queues | Queues | SQS | PostgreSQL outbox |
| workflows | Workflows | Step Functions | built-in driver or Temporal |
| realtime | Durable Objects | API Gateway WebSocket | in-process hub |
| schedules | Cron Triggers | EventBridge Scheduler | node-cron |

"Equivalent" is not a design goal here, it is a test result. The same 15
conformance scenarios (221 steps) run against every profile, and the
differential harness compares outcomes across them rather than asserting each
in isolation. Combinations that are *not* certified are listed as not
certified, with the reason, in [`RELEASE_MANIFEST.json`](RELEASE_MANIFEST.json).

## Install

```sh
brew install gmacko/tap/forgec     # macOS and Linux
cargo install forgegraph-cli       # from source, any platform with Rust 1.97+
```

Prebuilt binaries for macOS (arm64, x86_64) and Linux (arm64, x86_64) are
attached to every [release](https://github.com/gmackie/forgegraph/releases)
with SHA-256 checksums.

```sh
pnpm add @forgegraph/runtime       # the runtime your impl/ code imports
```

## A ten-line tour

```forge
package acme.commerce@1.0.0

resource Order {
  id: Id
  status: enum { pending, paid, shipped } = pending
  total: Money
  placedAt: Instant

  view mine(actor: ActorId) = where { customer == actor }
  transition pay(payment: PaymentRef) from pending to paid
}
```

```sh
forgec check ./acme            # parse, resolve, type-check, resolve path deps
forgec build ./acme --target cloudflare
forgec build ./acme --target aws
forgec migrate ./acme --from ./previous
```

`forgec build` emits the deployment plan, the SQL or DynamoDB access plan, the
migrations, the typed TypeScript client, the OpenAPI document and the Smithy
model. Your handwritten code lives in `impl/` and never mentions a provider.

Start with [docs/getting-started.md](docs/getting-started.md), then
[docs/language.md](docs/language.md).

## What is in this repository

**Compiler** (Rust, published to crates.io):

| crate | what it is |
| --- | --- |
| [`forgegraph-cli`](crates/forgegraph-cli) | the `forgec` binary and the language server |
| [`forge-syntax`](crates/forge-syntax) | lexer and lossless parser (logos + rowan) |
| [`forge-semantic`](crates/forge-semantic) | name resolution, type check, `domain-ir/1`, capability algebra, `diff` |
| [`forge-planner`](crates/forge-planner) | contracts, SQL and DynamoDB access plans, migration planning |
| [`forge-codegen`](crates/forge-codegen) | TypeScript client, OpenAPI, Smithy, OpenAPI import |

**Runtime and tooling** (TypeScript, published to npm under `@forgegraph/`):

| package | what it is | stability |
| --- | --- | --- |
| [`@forgegraph/runtime`](packages/runtime) | the engine: hosts, executors, policy, outbox, workflows, telemetry | stable candidate |
| [`@forgegraph/react`](packages/react) | hooks and cache for generated clients | stable candidate |
| [`@forgegraph/interfaces`](packages/interfaces) | OpenAPI/Smithy export, discovery, RPC bindings, MCP server, dashboards | stable candidate |
| [`@forgegraph/capability-manifest`](packages/contracts/capability-manifest) | the capability manifest contract | stable candidate |
| [`@forgegraph/registry`](packages/registry) | signed artifacts, catalog, deployment inventory, dependency grants | experimental |
| [`@forgegraph/governance`](packages/governance) | disposition planning, subject rights, redaction, control packs | experimental |
| [`@forgegraph/adapters`](packages/adapters) | provider packs, certification matrix, Terraform and self-hosted emitters | experimental |
| [`@forgegraph/release-gates`](packages/release-gates) | promotion gates over compatibility and evidence | experimental |
| [`@forgegraph/temporal`](packages/temporal) | Temporal workflow driver | experimental |

Stability tiers are defined in [docs/stability.md](docs/stability.md) and
recorded in each `package.json` under `forgegraph.stability`. Everything is
0.x: the tiers say how much churn to expect, not that anything is frozen.

**Reference application**: [`examples/acme`](examples/acme) is a real commerce
application — orders, payments, fulfilment, a React workspace, a Next.js
walkthrough — deployed to both clouds during certification. The conformance
suite in [`conformance/`](conformance) runs against it.

## Design notes worth knowing before you adopt it

- **Authentication fails closed.** Every host requires an `AuthHost`. There is
  a development mode that trusts `x-forge-tenant` / `x-forge-actor` headers; it
  must be opted into by name (`FORGE_AUTH=dev-headers`) and it announces itself
  loudly at startup. There is no default that silently trusts a header.
- **Portability is bounded, not universal.** The
  [portable profile](docs/portable-profile.md) defines exactly what is
  guaranteed across targets. Outside it, the compiler tells you what differs
  instead of pretending it does not.
- **Uncertainty is reported, not averaged away.** Missing metrics render as
  `missing`, never as a healthy zero; error budgets carry a band when telemetry
  export was incomplete; sampled data is labelled sampled.
- **Compatibility is computed.** `forgec compat` diffs two bundles and
  classifies each change by direction and stream; `forgec migrate` produces a
  phased plan. Neither guesses.

Full documentation is in [`docs/`](docs/README.md); architectural decisions and
their alternatives are in [`docs/decisions/`](docs/decisions).

## Status

0.3.0 is the first public release. The API surface is 0.x and will move — pin
exact versions.

What is certified against *this* build, per
[`RELEASE_MANIFEST.json`](RELEASE_MANIFEST.json):

| profile | status |
| --- | --- |
| `node-postgres`, `sqlite-node`, `runtime-memory` | certified |
| `cloudflare-d1`, `aws-dynamodb` | **unverified against this build** |

Cloudflare and AWS passed the full live suite — 15 scenarios, 221 steps,
realtime and provider switching in both directions — against build
`693d221a`. Renaming the compiler to `forgec` changed the build hash, and the
manifest's own rule is that live evidence does not transfer across a build:
re-run `pnpm certify` against your own deployments to restore the claim. The
evidence for the run that did happen is retained in
`conformance/certification/latest.json`, with the private hostnames withheld.

That is the whole point of the manifest — it would rather say "unverified"
than carry a claim forward on the strength of it being *probably* still true.

Known gaps are stated as gaps: see the `notCertified` entries in
`RELEASE_MANIFEST.json` and [docs/security-review.md](docs/security-review.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version: behaviour changes
start with a failing test, portability claims start with a conformance
scenario, and a claim without evidence does not land.

Security reports go to the process in [SECURITY.md](SECURITY.md), not to the
issue tracker.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
