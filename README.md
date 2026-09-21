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
brew install gmackorg/tap/forgec   # macOS and Linux
cargo install forgegraph-cli       # from source, any platform with Rust 1.97+
```

Prebuilt binaries for macOS (arm64, x86_64) and Linux (arm64, x86_64) are
attached to every [release](https://github.com/gmackie/forgec/releases)
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
| [`forgegraph-syntax`](crates/forgegraph-syntax) | lexer and lossless parser (logos + rowan) |
| [`forgegraph-semantic`](crates/forgegraph-semantic) | name resolution, type check, `domain-ir/1`, capability algebra, `diff` |
| [`forgegraph-planner`](crates/forgegraph-planner) | contracts, SQL and DynamoDB access plans, migration planning |
| [`forgegraph-codegen`](crates/forgegraph-codegen) | TypeScript client, OpenAPI, Smithy, OpenAPI import |

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

All five required profiles are certified against *this* build, per
[`RELEASE_MANIFEST.json`](RELEASE_MANIFEST.json):

| profile | evidence |
| --- | --- |
| `cloudflare-d1` | live: 15 scenarios, 221 steps, realtime, switching both ways |
| `aws-dynamodb` | live: 15 scenarios, 221 steps, realtime, switching both ways |
| `node-postgres`, `sqlite-node`, `runtime-memory` | differential: 221 steps compared, 0 unexplained |

Live evidence is bound to the build it ran against and to a 90-day window. If
either moves, the manifest downgrades that profile to `unverified` on its own
rather than carrying the claim forward — so a stale manifest tells you it is
stale instead of quietly lying. `conformance/certification/latest.json` holds
the full run; only the private hostnames are withheld, and they are marked as
withheld.

Known gaps are stated as gaps: see the `notCertified` entries in
`RELEASE_MANIFEST.json` and [docs/security-review.md](docs/security-review.md).

### Where this lives

Development and releases happen here, at
[`gmackie/forgec`](https://github.com/gmackie/forgec) — issues, pull requests
and the published artifacts all point at this repository, and npm provenance
attests to builds from it. ForgeGraph as a whole lives at
[gmackorg](https://github.com/gmackorg) and [forgegraf.com](https://forgegraf.com);
if the compiler moves into that monorepo, the repository URLs move with it in a
single commit and this note changes with them. Nothing in the published
metadata points at a repository that did not build it.

## Management console

The [Forge console](packages/console/README.md) uses Cloudflare Kumo, React and Effect
to manage applications, environment configuration and signed packages stored in an OCI
registry. Run it on Cloudflare Workers or Docker with your own authority, storage and
credentials; no central service is required.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). The short version: behaviour changes
start with a failing test, portability claims start with a conformance
scenario, and a claim without evidence does not land.

Security reports go to the process in [SECURITY.md](SECURITY.md), not to the
issue tracker.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
