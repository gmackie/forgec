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
- CLI: `forge check | fmt | inspect | lock | build | compat | lsp`

## Compiler (M1)

```
cargo run -p forge-cli -- check examples/acme     # parse, resolve, check (+ path deps, forge.lock)
cargo run -p forge-cli -- fmt --check examples/acme
cargo run -p forge-cli -- inspect examples/acme   # DomainIR JSON + build hash
cargo run -p forge-cli -- lock examples/acme
```

The binary is named `forge` per the plan; it is not installed on PATH here
because the ForgeGraph CLI already owns that name on this machine.
