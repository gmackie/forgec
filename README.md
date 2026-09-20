# Forge

Dual-target compiler and application runtime: one `.forge` package, the same
Effect implementation files, equivalent behaviour on Cloudflare (Alchemy / D1)
and AWS (CDK / DynamoDB).

- Design and implementation plan: `Forge_Dual_Target_Implementation_Plan.md`
- Decisions: `docs/decisions/`
- M0 executable spikes: `spikes/` (`pnpm spike:d1`, `pnpm spike:dynamo`)

Status: M0–M7 gates met (2026-09-20). CRUD, lifecycle actions, restrict
delete, changesets, idempotent recovery, blobs (R2/S3) and CSV import run on
both targets with one client and one React workspace; see
`conformance/README.md`. Implemented functions, channels and subscriptions deliver through Cloudflare
Queues / SQS with per-subscription outbox status. Effective-dated and
hierarchical resources are guarded in one commit; bounded views, rebuildable
projections (contribution ledger, stale-event safe) and cache readers with
effective-boundary freshness ride the same outbox and document primitives.
Workflows run on one portable executor driven natively by Cloudflare
Workflows and Step Functions; schedules compile to a recurrence IR with an
occurrence ledger behind Cron Triggers / EventBridge; the realtime profile
streams channel messages over Durable Objects / API Gateway WebSocket with
sequence numbers and bounded replay. Next: M8 (observability, migration,
limits, docs, LSP, packaging).

## Compiler (M1)

```
cargo run -p forge-cli -- check examples/acme     # parse, resolve, check (+ path deps, forge.lock)
cargo run -p forge-cli -- fmt --check examples/acme
cargo run -p forge-cli -- inspect examples/acme   # DomainIR JSON + build hash
cargo run -p forge-cli -- lock examples/acme
```

The binary is named `forge` per the plan; it is not installed on PATH here
because the ForgeGraph CLI already owns that name on this machine.
