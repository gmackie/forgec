# Forge

Dual-target compiler and application runtime: one `.forge` package, the same
Effect implementation files, equivalent behaviour on Cloudflare (Alchemy / D1)
and AWS (CDK / DynamoDB).

- Design and implementation plan: `Forge_Dual_Target_Implementation_Plan.md`
- Decisions: `docs/decisions/`
- M0 executable spikes: `spikes/` (`pnpm spike:d1`, `pnpm spike:dynamo`)

Status: M0–M2 gates met (2026-09-20). The reference app's CRUD runs on both
targets with one client; see `conformance/README.md` for the certification
table. Next: M3 (mutation integrity, changesets, bulk).

## Compiler (M1)

```
cargo run -p forge-cli -- check examples/acme     # parse, resolve, check (+ path deps, forge.lock)
cargo run -p forge-cli -- fmt --check examples/acme
cargo run -p forge-cli -- inspect examples/acme   # DomainIR JSON + build hash
cargo run -p forge-cli -- lock examples/acme
```

The binary is named `forge` per the plan; it is not installed on PATH here
because the ForgeGraph CLI already owns that name on this machine.
