# Conformance: parity as an executable specification

`conformance/` holds the specification that both targets must satisfy.

- `scenarios/*.json`: ordered operation calls with expectations in placeholder
  space (`$step.field`, `$id:n`), race steps with outcome counts, transfer
  steps for signed URLs, and `eventually` polling for asynchronous read models.
- `test/runner.test.ts`: every scenario against the deterministic in-memory
  semantic model (seeded ids and clock) — the reference.
- `test/vectors.test.ts`: codec golden vectors (`specs/codecs/vectors`), shared
  with the Rust compiler's tests.
- `test/migrations.test.ts`: the reviewed D1 baseline equals the generated one.
- `test/remote.test.ts`: every scenario through the generated client against a
  live deployment (`FORGE_TARGET_URL`, `FORGE_TARGET_NAME`); writes
  `reports/<name>.json`.
- `test/realtime.test.ts`: the WebSocket profile live (`FORGE_TARGET_WS`).
- `test/switch.test.ts`: provider switching live (`FORGE_SOURCE_URL` →
  `FORGE_TARGET_URL`).
- `src/bench.ts`: measured latencies and atomic budgets per provider.
- `src/certify.ts`: runs all of the above against both clouds and writes
  `certification/latest.json` (source-controlled): commit, build hash, per-target
  scenario counts, realtime, switching both ways, benchmarks, `certified`.

```
FORGE_CF_URL=... FORGE_CF_WS=... FORGE_AWS_URL=... FORGE_AWS_WS=... pnpm certify
```

The release claim is earned by this run, not by having two sets of templates.
