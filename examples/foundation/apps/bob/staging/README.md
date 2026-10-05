# Bob Foundation reconciliation staging

This is an isolated deployment of Bob's authenticated reconciliation operation
and the actual Foundation adapter, with separate native PostgreSQL17 databases.
It is not a full Bob web deployment or a production-history migration.
The Bob endpoint/service changes are in [PR216](https://git.forgegraf.com/gmackie/bob/pulls/216).

The service accepts only a credentialed completion fact matching a server-owned
run/user/workspace/session/planning-item binding. The bound Fulfillment must have
an independently recorded request and start. It never executes the Bob task.
Bob's API validates the native API key, write permission, current workspace
membership and persisted run before forwarding the fact. No user-supplied
Foundation IDs or actor identity are accepted.

## Current deployment

Host: `hetzner-bob`. Private state: `/opt/forge-bob-staging-20261001/`.
Credentials: `config.json` (operator/read API keys, service credential and trusted
bindings), `stage.env` (dedicated database connection references). Both are
private operator files, not artifacts to upload or commit.

- `forge-bob-stage-api-1001`: Bob HTTP, loopback 4310.
- `forge-bob-stage-foundation-1001`: Foundation HTTP, loopback 4311.
- `forge-bob-stage-db-1001`: PostgreSQL17, loopback 55491; databases `bob_stage`
  and `foundation_stage`. Persistent data remains in the private `pgdata/`.

Reach the operation over an SSH tunnel, for example:

```sh
ssh -L 4310:127.0.0.1:4310 root@hetzner-bob
```

It remains enabled only in this isolated deployment. Bob production and existing
Foundation certification infrastructure are unchanged. Do not merge Bob's PR
merely to run staging: its master CI automatically deploys production.

## Reproduction

Use Bob's `scripts/foundation-staging/schema.mts` to emit its current native schema
into a fresh isolated database. `seed.mts` inserts explicit synthetic users,
hashed API keys and persisted completed runs; never target a production database.
Compile `examples/foundation/apps/bob` with forgec and apply its PostgreSQL DDL to
a different empty database. `seed.ts` creates explicit synthetic request/start
facts and records the generated Fulfillment ID in each trusted binding.

With the normal locked workspace dependencies installed, `build.mjs` bundles the
Bob `server.mts`/`seed.mts` or this directory's `server.ts`/`seed.ts` entrypoints to
ESM. It leaves `pg` external (the staging install pins 8.23.0). Run with Node24.14.0.
`compose.yml` documents the equivalent three-container layout; the initial
containers were created with `docker run`. Do not run Compose over those existing
container names without first stopping/replacing those staging containers.

Both servers use bounded request bodies and bind to loopback. The Foundation
server uses `composeRuntime` with production IDs and clocks; deterministic
`testLayer` IDs collide when separate processes share persisted storage. The
initial deployment caught that mistake; the retained acceptance passes after the
host composition fix without changing runtime semantics.

`accept.mjs` checks unauthenticated/read-only/cross-workspace/forged-identity
rejection plus successful and idempotent reconciliation. Stop Foundation and run
`--outage`; restart both services and run `--replay`. Restart Bob with
`STAGE_ENABLED=0` and run `--disabled`, then restore it and repeat `--replay`.
`db-check.mjs` verifies the native Bob status/completion/owner/session and exactly
one linked Foundation terminal fact. These scripts read credentials privately
from `/stage/config.json`; their retained output contains no credential values.

## Rollback and scope

Disable Bob's port by setting `STAGE_ENABLED=0` for the isolated runner (or removing
`BOB_FOUNDATION_COMPLETION_URL` in the real app composition). Preserve both stores;
no reconciliation retry runs the task again. Restore the same configuration and
retry the same run to resume. The receiver also requires exact session/planning
identity, and does not claim isolated callable attestation for a shared service
credential.

The 2026-10-01 evidence under `docs/foundation/staging/bob-2026-10-01/` establishes
this explicit request path with synthetic native records and real PostgreSQL
writes. It does not establish automatic task-completion hooks, real agent
execution, full web UI rollout, arbitrary tenant onboarding or production
migration completeness. Those remain in #195.

## Extended live verification

Run `verify-live.mjs` inside the staging Node container with the same private
mount, host network and `stage.env` as `db-check.mjs`. It checks key revocation and
expiry, membership downgrade/removal, changed persisted run facts, receiver
credentials/input shape and 12 simultaneous duplicate requests. Native mutations
are restored in `finally`; exact Foundation rows must remain unchanged.

For recovery, run `verify-recovery.mjs prepare` once on the dedicated staging
databases. It retains two additional synthetic bindings in private config and
`recovery-fixtures.json`: one with an independently seeded start, one without.
Restart the Foundation staging service to load the bindings, then run
`verify-recovery.mjs exercise`. A temporary PostgreSQL trigger rejects only the
new test run's link insert, after its terminal fact commits. The script requires
503 with a redacted error, exactly one terminal and zero links, removes the
trigger in `finally`, and verifies that retry repairs the missing link. It also
requires the unstarted fixture to fail without manufacturing any start/end/link.
Restart both staging services and run `verify-recovery.mjs replay` to verify
stable IDs under 12 concurrent retries. Keep the synthetic records for replay;
do not rerun `prepare` against the same fixture state.

Both scripts check database names before mutations. They are for this disposable
staging deployment only. Output is credential-free JSON (`live-verification.json`,
`recovery-exercise.json`, `recovery-replay.json`). Run `db-check.mjs` afterward to
confirm that the original fixture remains intact. An externally killed process
can bypass JavaScript cleanup; if that occurs, restore native fixture state or
remove `staging_fail_run_link` on the staging database before resuming.
