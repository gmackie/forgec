# Changelog

## Unreleased

- M20 observability: telemetry governance context and attempt/completion
  phases; `@forge/governance` redaction and sink policies; `@forge/interfaces`
  dashboards; `@forge/registry` signed evidence and drift reports.

- M19 governance: `@forge/governance` (disposition planner, rights executor,
  recovery evidence, control packs + OSCAL); runtime suppression ledger
  (`Suppressed` 410 on recreation, import replays current suppression).

- M18 providers: `@forge/adapters` (certification matrix, managed Postgres
  profiles + qualification, node:sqlite executor with the full conformance
  suite, resolved deployment plans, Terraform and self-hosted packs);
  `forge_outbox.trace` in the shared baseline; idempotent D1 migrations.

- M17 rollout: `forge compat` is now `forge_semantic::diff` with direction,
  needs, interfaces/governance/dependencies/policy streams and `--report`;
  `forge migrate` emits a phased migration plan; deployment ledger
  (`@forge/runtime` DeploymentLedger); export `excluded` section;
  `docs/provider-cutover.md`; `@forge/release-gates`.

- M16 grants: `@forge/registry/grants`, `approval-bot`, `grant-publication`;
  `schemas/dependency-grant.schema.json`; `docs/grant-lifecycle.md`.

- M15 registry: `@forge/registry` (content-addressed signed artifacts with
  digest-locked resolution, rebuildable catalog with namespace/audience
  confidentiality and authority-qualified identities, deployment inventory
  separating signed reports from observations, signed expiring policy
  snapshots bounding any Authorizer offline).

- M14 interfaces: `forge build` emits `openapi.json` and `api.smithy`; every
  host serves `GET /forge/discovery` and `/forge/openapi.json`; new
  `@forge/interfaces` package (RPC callable bindings, MCP server mounted at
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
