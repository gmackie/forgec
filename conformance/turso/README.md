# Hosted Turso qualification

Run from the repository root with Node 24, built runtime packages, and the existing
management credential in `TURSO_API_KEY`:

```sh
pnpm --filter @forgegraph/runtime build
python3 scripts/qualify-turso.py --organization gmackie \
  --state-dir "$HOME/.local/state/forgegraph/providers/turso-qualification" \
  --evidence conformance/reports/turso/live.json
```

The harness creates a randomly named `forge-cert-*` database in the `default`
group, issues a one-hour database token, and deletes the database in `finally`.
The management token remains in the environment; the database token reaches the
Node runner through stdin. Neither token is included in evidence or arguments.
The state directory records the owned resource before creation. Keep that
private directory until cleanup completes. Following interruption, repeat with
`--cleanup-only`; a normal invocation refuses outstanding owned state.

The retained live evidence covers binary values, atomic batch rollback,
concurrent publication-journal claims, immutable receipts across clients,
Foundation atomic absence guards, tenant isolation, and missing-reference
rejection without partial writes. It does not certify replicas, failover,
production capacity, process-loss recovery, or the entire hosted Foundation
profile. Source digests pin the implementation used by the live run.

Lifecycle failure tests:

```sh
python3 -m unittest discover -s scripts -p test_turso_qualification.py
```
