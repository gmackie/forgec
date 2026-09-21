# Forge

Dual-target compiler and application runtime: one `.forge` package, the same
Effect implementation files, equivalent behaviour on Cloudflare (Alchemy / D1)
and AWS (CDK / DynamoDB).

- Design and implementation plan: `Forge_Dual_Target_Implementation_Plan.md`
- Decisions: `docs/decisions/`
- M0 executable spikes: `spikes/` (`pnpm spike:d1`, `pnpm spike:dynamo`)

Status: M0–M8 complete and certified (2026-09-20): the Acme reference
application runs the same `.forge` package, generated client, React workspace
and `impl/` sources on Cloudflare (Workers + D1 + R2 + Queues + Workflows +
Durable Objects + Cron Triggers) and AWS (HTTP API + Lambda + DynamoDB + S3 +
SQS + Step Functions + EventBridge + API Gateway WebSocket). 15 conformance
scenarios / 221 steps, the realtime profile and provider switching in both
directions pass live on both; see `conformance/certification/latest.json` and
`docs/`.

- Documentation: `docs/` (getting started, language, portable profile,
  deployment, operations, conformance)
- CLI: `forge check | fmt | inspect | lock | build | compat | lsp | explain | import-openapi`

Post-M8 program (`docs/post-m8/STATUS.json`): M9–M21 done — Postgres/Node
profile, data taxonomy and governance, purpose capability algebra, trusted
invocation context and Gatekeeper, and the interface layer (OpenAPI/Smithy
exports, `/forge/discovery`, RPC bindings, MCP server, `forge-api` CLI,
Python/Go SDKs, pinned OpenAPI importer; `packages/interfaces`,
`specs/interfaces/conformance.json`), and the registry (`packages/registry`:
signed immutable artifacts, derived catalog with confidential access, deployment
inventory, signed policy snapshots) and callee-owned dependency grants
(request → reviewed PR → signed grant → activation; `docs/grant-lifecycle.md`),
and rollout control (`forge compat`/`forge migrate`, deployment ledger,
`docs/provider-cutover.md`, `packages/release-gates`), and provider packs
(`packages/adapters`: certification matrix, managed Postgres and SQLite
qualification, Terraform and Docker/Nix emitters; `specs/profiles/matrix.json`), and subject
rights (`packages/governance`: disposition planner, durable rights executor,
suppression ledger in the runtime, recovery evidence, control packs / OSCAL),
and observability (governance context in telemetry, classification-aware
redaction, generated dashboards, signed deployment evidence, drift reports;
`docs/operational-verification.md`), and the certified release
(`RELEASE_MANIFEST.json`, `conformance/reports/differential.json`,
`conformance/benchmarks/`, `docs/security-review.md`,
`docs/acme-next-walkthrough.md`). Post-release: `packages/temporal`
(Temporal-driven workflows, certified single-node), embedded libsql, OTLP sink.

## Compiler (M1)

```
cargo run -p forge-cli -- check examples/acme     # parse, resolve, check (+ path deps, forge.lock)
cargo run -p forge-cli -- fmt --check examples/acme
cargo run -p forge-cli -- inspect examples/acme   # DomainIR JSON + build hash
cargo run -p forge-cli -- lock examples/acme
```

The binary is named `forge` per the plan; it is not installed on PATH here
because the ForgeGraph CLI already owns that name on this machine.
