# PostgreSQL contention evidence

Tracking: https://github.com/gmackie/forgec/issues/82

PostgreSQL independent writers can exhaust the serialization retry budget under CI contention

The existing PostgreSQL concurrency regression test failed on frozen Foundation source `f98cee96` in the Node 22 hosted matrix: 2 of 64 logically independent Customer.create calls returned retryable HTTP 503 `TransientConflict`, with PostgreSQL reporting `could not serialize access due to read/write dependencies among transactions`. The assertion requires all 64 creates to succeed, then checks every record is durable. The test uses a 16-connection pool and took 2742 ms; its timeout is 120 seconds, so this was a returned runtime failure, not a timeout.

Evidence:

- Hosted run: https://github.com/gmackie/forgec/actions/runs/35894158062 (initial attempt failed; failed-job retry passed on the same source; all CI jobs now pass).
- Captured initial Node 22 log: `/tmp/foundation-new-node22.log`, failure at lines 1475 and 1765–1766.
- Root reports Node 24 and every other matrix job passed on the same frozen source.
- `jj diff --from 466efe47 --to f98cee96 -- packages/runtime/src/adapters/postgres.ts packages/runtime/test/postgres.test.ts` is empty. These adapter/test files were unchanged from baseline; this does not prove the full surrounding workload unchanged.
- Local Node v22.22.0: 11 sequential focused runs passed, 704 total creates plus their durability reads. Each run reported 1 test passed / 33 skipped, taking 1.15–1.43 seconds overall. Logs: `/tmp/forge-retry-focused-{1..11}.log`.
- Local reproduction command, using a separate disposable database because this test drops/recreates its public schema: `FORGE_PG_URL=postgres://forge@127.0.0.1:55479/forge_retry_diagnosis pnpm --filter @forgegraph/runtime exec vitest run test/postgres.test.ts -t 'concurrent commits that share'`.

Current behavior:

`PostgresStorage` uses SERIALIZABLE transactions and translates PostgreSQL serialization/deadlock/lock errors into transient conflicts. `D1Storage.commitAll` retries the whole commit transaction with the same immutable plan, reevaluating its preconditions, up to 10 total attempts for PostgreSQL. The nine sleeps are `floor(2 ** attempt * 2 + random() * 10 * attempt)` ms: approximately 2044–2485 ms total sleep, excluding database work. This is a finite contention budget. The final transient conflict is intentionally exposed after exhaustion. The observed duration is consistent with that path; per-attempt tracing was not captured.

The test comments identify shared assertion/outbox writes as potential SERIALIZABLE predicate-lock overlap even when business records are disjoint. The particular lock/statement responsible for these two exhausted requests has not been isolated. Passing focused runs do not reproduce hosted concurrency or prove this is harmless.

Follow-up investigation should distinguish (1) insufficient budget or narrowly jittered synchronized retries, (2) predicate-lock amplification from shared protocol tables/index access, and (3) resource contention from concurrent test files. Preserve the zero-failure and durable-read assertions. Capture per-request attempt counts and SQLSTATE/transaction stage in an isolated stress harness, compare focused and full-suite workloads on constrained resources, then validate any retry-policy or transaction-footprint change against genuine business-state conflicts and cross-adapter invariants. Avoid raising retries blindly: that can conceal contention and increase latency without establishing progress.

No source edits or weakened assertions were made during diagnosis. A successful hosted rerun should be recorded as additional evidence, not erase the initial failure. This is an existing bounded-progress limitation exposed by CI; Foundation-specific causation has not been established.
