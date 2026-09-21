# Changelog

## Unreleased

## 0.3.0 (2026-09-21)

First public release. The project is now **ForgeGraph**: the compiler ships as
the `forgec` binary from the `forgegraph-cli` crate, and the runtime packages
are published on npm under the `@forgegraph` scope. Everything is Apache-2.0
and developed in the open at https://github.com/gmackie/forgec.

### Breaking

- The CLI binary is `forgec`, not `forge`. Every command, flag and output
  format is unchanged; only the name moved. `forge` is taken on crates.io and
  by Foundry, and the old name could not be published.
- npm packages moved from `@forge/*` to `@forgegraph/*`. Update imports; no
  API changed with the move.
- `createNodeHost` now **refuses to start without an `AuthHost`**. It
  previously fell back to development header auth, which meant a Node
  deployment that forgot to configure authentication trusted
  `x-forge-tenant` / `x-forge-actor` from the caller. Pass `auth`, or set
  `FORGE_AUTH=dev-headers` to opt into the development behaviour by name. The
  Cloudflare and AWS hosts already failed closed; all three now log a loud
  warning whenever development auth is active.

### Added

- Published artifacts: five crates on crates.io, nine packages on npm with
  build provenance, prebuilt `forgec` binaries for macOS and Linux on both
  architectures, and a Homebrew formula at `gmackorg/tap/forgec`.
- `docs/stability.md`: a per-package stability tier, also recorded in each
  `package.json` under `forgegraph.stability`.
- `docs/releasing.md`: the release process, the required secrets, and how to
  bootstrap the shared Homebrew tap.
- CI (`.github/workflows/ci.yml`): compiler on stable and 1.97, runtime on
  Node 22 and 24 against PostgreSQL 17, a stale-fixture check, the
  cross-profile differential, a packaging dry-run, and supply-chain audits.
- Release automation (`.github/workflows/release.yml`) and a Forgejo mirror.

### Changed

- `@forgegraph/temporal`: Temporal WorkflowDriver + worker; profile
  `self-hosted-full` certified on a single-node Temporal dev server.
- `@forgegraph/adapters/sqlite`: embedded libsql executor certified through the
  D1 adapter.
- `OtlpSink` and `telemetryFormat: "otlp"` on the Node host.
- Live deployment identifiers in `examples/acme` are placeholders. The
  certification evidence in `conformance/certification/latest.json` keeps every
  result and withholds only the private hostnames, marked as withheld.
- Re-certified live against build `cfc8286a` after the rename: Cloudflare
  (Workers + D1 + R2 + Queues + Workflows + Durable Objects + Cron Triggers)
  and AWS (HTTP API + Lambda + DynamoDB + S3 + SQS + Step Functions +
  EventBridge + API Gateway WebSocket), 15 scenarios / 221 steps each, realtime
  and provider switching in both directions, plus the differential across
  memory / sqlite-node / PostgreSQL with 0 unexplained differences. All five
  required profiles are certified against this build.
- `examples/acme/deploy/cloudflare/resolve-config.mjs`: the committed
  `wrangler.jsonc` keeps placeholders, and the `cf:*` scripts resolve a
  gitignored copy from `FORGE_D1_DATABASE_ID`. A public repository should not
  name someone else's database, and an editable placeholder is a placeholder
  waiting to be committed by accident.
- The workflow-failure assertion in `conformance/scenarios/workflows.json` now
  gets the same 30s poll budget as the workflow-completion assertion beside it.
  At 5s it failed under parallel load while passing in isolation — a flaky
  test, not a flaky runtime.
- Re-pinned the adapter capability manifest digests in `examples/acme`, whose
  IDs moved to the `@forgegraph` scope.
- `cargo clippy -D warnings` and `cargo fmt --check` now pass workspace-wide
  and are enforced in CI.

## 0.2.0 (2026-09-21)

Post-M8 program M9–M21 complete. Live certification of both clouds on
build 693d221a70f7; differential across memory / sqlite-node / PostgreSQL;
RELEASE_MANIFEST.json lists every certified combination with evidence and
every withheld one with its reason.

- M21 release: differential certification, capability fuzz, adversarial
  suites, governance benchmarks, `forge upgrade-edition`, release manifest.

- M20 observability: telemetry governance context and attempt/completion
  phases; `@forgegraph/governance` redaction and sink policies; `@forgegraph/interfaces`
  dashboards; `@forgegraph/registry` signed evidence and drift reports.

- M19 governance: `@forgegraph/governance` (disposition planner, rights executor,
  recovery evidence, control packs + OSCAL); runtime suppression ledger
  (`Suppressed` 410 on recreation, import replays current suppression).

- M18 providers: `@forgegraph/adapters` (certification matrix, managed Postgres
  profiles + qualification, node:sqlite executor with the full conformance
  suite, resolved deployment plans, Terraform and self-hosted packs);
  `forge_outbox.trace` in the shared baseline; idempotent D1 migrations.

- M17 rollout: `forge compat` is now `forge_semantic::diff` with direction,
  needs, interfaces/governance/dependencies/policy streams and `--report`;
  `forge migrate` emits a phased migration plan; deployment ledger
  (`@forgegraph/runtime` DeploymentLedger); export `excluded` section;
  `docs/provider-cutover.md`; `@forgegraph/release-gates`.

- M16 grants: `@forgegraph/registry/grants`, `approval-bot`, `grant-publication`;
  `schemas/dependency-grant.schema.json`; `docs/grant-lifecycle.md`.

- M15 registry: `@forgegraph/registry` (content-addressed signed artifacts with
  digest-locked resolution, rebuildable catalog with namespace/audience
  confidentiality and authority-qualified identities, deployment inventory
  separating signed reports from observations, signed expiring policy
  snapshots bounding any Authorizer offline).

- M14 interfaces: `forge build` emits `openapi.json` and `api.smithy`; every
  host serves `GET /forge/discovery` and `/forge/openapi.json`; new
  `@forgegraph/interfaces` package (RPC callable bindings, MCP server mounted at
  `/forge/mcp`, `forge-api` CLI) plus Python and Go SDKs certified on one
  cross-language scenario; `forge import-openapi` (pinned, offline, host
  allow-list); compiler E-WF-008 type-checks workflow step arguments.
- `localAuthorizer` evaluates policies independently (a policy whose PIP
  attribute is missing is skipped, never a reason to allow).

## 0.1.0 (2026-09-20)

First certified release of the dual-target toolchain: compiler (syntax,
semantics, planners, codegen, CLI with `check|fmt|inspect|lock|build|compat|lsp`),
Effect runtime with memory / D1 / DynamoDB adapters, Cloudflare and AWS hosts,
React workspace, and the conformance suite. Milestones M0–M8 of the
implementation plan; see `conformance/certification/latest.json`.
