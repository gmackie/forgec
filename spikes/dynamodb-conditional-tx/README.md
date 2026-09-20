# Spike: DynamoDB conditional transactions

**Questions (plan §11.3–11.5):** does one `TransactWriteItems` carrying
entity + unique claim + audit + outbox cancel atomically on a stale version?
Does a unique-claim item admit exactly one concurrent creator? Can a parent
delete race child creates into an orphan under a dependents-counter guard?
What do client request tokens actually give us?

**Answer: the protocol holds — validated against live DynamoDB (us-east-1)
on 2026-09-20, 13 scenarios, 5 consecutive green runs.** Two findings change
adapter design details (below).

## Items and operations

| item | key | written by |
| --- | --- | --- |
| Entity | `T#t#R#customer#I#id / ENTITY` (`version`, `active`, `dependents`) | create, update, delete |
| Unique claim | `T#t#R#customer#U#code#<value> / CLAIM` | create (`attribute_not_exists`) |
| Audit | `T#t#A#<opId> / AUDIT` | every op |
| Outbox | `T#t#O#<opId> / E#<ordinal>` | create, update |

- `createCustomer`: Put entity (not exists) + Put claim (not exists) + audit + outbox.
- `updateCustomer`: Update entity cond `version = :v AND active = true` + audit + outbox.
- `createSite`: Update **parent** `dependents + 1` cond `attribute_exists AND active = true` + Put site (not exists) + audit.
- `deleteCustomer`: Update entity `active = false` cond `active = true AND dependents = 0` + audit.

The parent guard is a conditional *Update* on the parent item, not a
`ConditionCheck` plus a separate Update (DynamoDB forbids two actions on one
item in a transaction, §11.4).

## Observed

| scenario | result |
| --- | --- |
| create | all four items present under a consistent read |
| 8 concurrent creates claiming one code | exactly 1 winner; 1 entity, 1 claim, 1 audit, 1 outbox |
| duplicate id | `AlreadyExists`, nothing written |
| stale version update | `TransactionCanceledException` with `[ConditionalCheckFailed, None, None]`; no audit, no outbox, entity unchanged |
| 8 concurrent updates, same expected version | exactly 1 winner; version 2; exactly 2 audit/outbox rows (create + winner) |
| child then restrict-delete | delete fails `HasDependents`; parent still live |
| delete then child | child fails `ParentUnavailable`, no site, no audit; second delete `AlreadyDeleted` |
| delete racing 6 child creates (×5 runs) | never an orphan: either delete wins and 0 sites exist, or ≥1 child wins, delete fails, `dependents == live sites`. In one run the **delete itself** lost to `TransactionConflict`. |
| same `ClientRequestToken`, same content, replayed | succeeds; no duplicate items |
| same token, different content | `IdempotentParameterMismatchException` |
| no token, replayed | semantic `AlreadyExists` |

### Finding 1 — contention surfaces as `TransactionConflict` first

Under concurrent transactions touching the same item, most losers do **not**
see the semantic `ConditionalCheckFailed`; they see cancellation reason
`TransactionConflict` ("Transaction is ongoing for the item"). Across runs the
7 losers of the update race split roughly 5–6 `TransactionConflict` : 1–2
`VersionConflict`.

Consequence: the adapter must treat `TransactionConflict` as a *retryable
operational conflict* (bounded backoff, same logical command, same generated
IDs) and only classify the semantic outcome after the retry lands on a
condition failure. This is consistent with §9 ("automatic retries are limited
to declared retryable operational conflicts; a stale user revision is not
silently retried") — the retry is of the *transaction attempt*, and the
resulting `VersionConflict` is still surfaced to the caller. It also confirms
the §11.4 warning: a parent `dependents` counter is a hot key; `forge explain`
must report it.

### Finding 2 — `CancellationReasons[].Item` is raw AttributeValue JSON

`ReturnValuesOnConditionCheckFailure: ALL_OLD` does return the old item in the
exception, which lets one condition failure be split into `HasDependents` vs
`AlreadyDeleted` without a second read. But the item arrives as raw
`{ "active": { "BOOL": false } }` even through `DynamoDBDocumentClient`;
it must be passed through `unmarshall` explicitly. The first spike run failed
on exactly this.

### Error shape

```
TransactionCanceledException
  message: "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed, None, None]"
  CancellationReasons: [{ Code, Message, Item? }]  // index-aligned with TransactItems
```

`CancellationReasons` is index-aligned with `TransactItems`, so the adapter
can map each physical action back to its logical role (entity / claim /
parent / audit / outbox) and derive a stable outcome without parsing the
message.

### Client request token

`ClientRequestToken` gives a genuine idempotent replay of an identical
transaction (10-minute window per AWS docs) and rejects a different payload
under the same token. It does not survive beyond that window and does not
return the prior result, so it complements — does not replace — the persisted
Forge idempotency receipt (§12).

## Consequences for the design

- Entity + claim + audit + outbox in one `TransactWriteItems` is certifiable
  for the Dynamo adapter; the item budget accounting in §3.4 is real (a plain
  create already costs 4 actions; each unique key and access item adds one).
- Add `TransactionConflict` to the retryable-outcome taxonomy; make the retry
  loop part of the shared mutation engine, not the caller.
- Use `ReturnValuesOnConditionCheckFailure` + `unmarshall` to refine outcomes
  from a single failed transaction.
- The dependents-counter guard is correct but contended; the planner should
  offer the coarser per-parent revision guard only where restrict-delete is
  declared, and report the hot-key risk.

## Running

```
pnpm install
AWS_REGION=us-east-1 pnpm test    # creates table forge-spike-tx on first run
```

Resource left in place: table `forge-spike-tx` (on-demand, tagged
`forge=m0-spike`). Tear down with
`aws dynamodb delete-table --table-name forge-spike-tx`.
