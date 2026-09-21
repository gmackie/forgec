# Changelog

## Unreleased

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
