# Spike: D1 guarded batch

**Question (plan §10.3):** can a failed version precondition inside
`D1Database.batch()` abort the audit/outbox writes in the same batch, given
that a conditional `UPDATE` matching zero rows is not an SQL error?

**Answer: yes — validated against live D1 on 2026-09-20.** Both assertion
placements work, batches are atomic, and concurrent guarded updates admit one
winner.

## Protocol under test

```sql
-- predicate-first (the plan's sketch)
INSERT INTO _forge_assert (op_id, satisfied)
  SELECT ?op, EXISTS (SELECT 1 FROM customer WHERE tenant=? AND id=? AND version=?);
UPDATE customer SET ..., version = version + 1 WHERE tenant=? AND id=? AND version=?;
INSERT INTO audit ...;
INSERT INTO outbox ...;
DELETE FROM _forge_assert WHERE op_id = ?op;

-- changes-after
UPDATE customer ... WHERE ... AND version=?;
INSERT INTO _forge_assert (op_id, satisfied) VALUES (?op, changes());
INSERT INTO audit ...; INSERT INTO outbox ...; DELETE FROM _forge_assert ...;
```

`_forge_assert.satisfied` carries `CONSTRAINT forge_precondition CHECK (satisfied = 1)`.

## Observed on live D1

| scenario | result |
| --- | --- |
| matching version, either variant | record, audit, outbox committed; assertion row released |
| stale version, either variant | batch throws; **no** audit, **no** outbox, no leftover assertion row, record untouched |
| 10 concurrent updates with the same expected version, either variant | exactly 1 success, 9 `VersionConflict`; version 2; 1 audit; 1 outbox |
| audit insert followed by failing CHECK in the same batch | audit row absent afterwards (earlier statements are rolled back) |
| control: unguarded batch with stale version | `UPDATE` reports 0 rows changed and the batch "succeeds" — audit and outbox rows for the stale op **are written**. This is the hazard. |

`changes()` does see the immediately preceding statement of the same batch,
so the `changes-after` variant is viable too. `predicate-first` is preferable
for Forge because the predicate can express reference/temporal conditions
that are not "rows changed by the previous statement".

### Provider error shape

D1 raises a plain `Error` with no structured code. The message (and
`cause.message`) is:

```
D1_ERROR: CHECK constraint failed: forge_precondition: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)
```

With an **unnamed** CHECK the token in that position is the SQL expression
(`satisfied = 1`). Naming the constraint gives the adapter a Forge-owned token
to match, which is the least fragile signal D1 currently offers. The `batch()`
result carries `meta.changes` per statement on success, so the adapter can
additionally assert `changes === 1` on the guarded statement as a belt-and-braces
check after a successful batch.

## Consequences for the design

- The assertion-table + named CHECK lowering is certifiable for the D1 adapter.
- Every precondition (version, reference existence, interval non-overlap) can be
  folded into the `EXISTS (...)` predicate of the assertion insert, so one
  mechanism covers §10.3, §11.4-equivalent reference guards and §18 overlap checks.
- Error translation: match `CHECK constraint failed: <forge-token>`; distinct
  tokens per assertion class (`forge_precondition`, `forge_reference`, ...) can
  distinguish outcomes without parsing SQL expressions. Confirm the message
  format is stable across D1 releases by keeping this spike in CI-on-demand.
- One batch per logical command is the transactional unit. Do not rely on
  `exec()` or JS-side read-then-write.

## Running

```
pnpm install
pnpm exec wrangler d1 create forge-spike-guarded-batch    # once; put the id in wrangler.jsonc
pnpm migrate:remote
openssl rand -hex 24 | pnpm exec wrangler secret put SPIKE_TOKEN
pnpm deploy
# .spike-env: SPIKE_URL=https://forge-spike-d1-guarded-batch.<subdomain>.workers.dev
#             SPIKE_TOKEN=<the token>
pnpm test
```

Resources left in place: Worker `forge-spike-d1-guarded-batch`, D1
`forge-spike-guarded-batch` (id `03a79977-48d7-4d34-b404-c6fb9eee7fcf`).
Tear down with `wrangler delete` and `wrangler d1 delete forge-spike-guarded-batch`.
