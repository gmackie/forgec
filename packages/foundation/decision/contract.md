# Decision system

Implements issue #39 with typed Participation, EvidenceSeal and EvaluationFinish references. Application satellites own their subjects and reference DecisionCase; cases have no universal subject pointer. `fixtures/consumer` compiles synthetic HumanApproval, ReleaseGate and ReviewBoardDecision wrappers.

## API and interpretation

`Decisions.open(input, context)` pins 1–16 explicit Participation electors, their known ParticipationEnd facts, an eligibility instant, 1–16 ordered option labels, deadline, threshold and `decision-rule/1`. Options and invitations are established at opening; changing the electorate or options requires a new case. Duplicate Party electorate slots are rejected. Later backdated membership termination does not rewrite the recorded eligibility snapshot. This is a snapshot of facts known at opening, not a claim of omniscient historical eligibility.

`respond(case, voter, ranking, context, support?)`, `withdraw(case, response, context)`, `finalize(case, context)` and `expire(case, context)` append events. `state(case, context)` is the authoritative interpretation: it replays the journal, validates eligibility, support, rankings, complete options, outcome members, digest and selected winner. Domain code must use this validated state. Raw DecisionOutcome rows are immutable **candidates**, not decisions. Malformed raw journal selections fail closed and can make a case uninterpretable; applications must restrict journal writes to their command authority.

Reconsideration uses `open({...input, reconsideration: terminalCase}, context)`. It creates a separate case and preserves both histories. EvaluationFinish and EvidenceSeal are immutable support references, never floating evaluator or evidence identifiers.

| Rule | Pinned semantics |
| --- | --- |
| Single | Exactly one elector, one selected option. |
| ChooseOne | Exactly one elector, at least two options. |
| First | First currently active response in journal order; withdrawal permits the next active response. |
| Quorum | Threshold of distinct electors; plurality winner, ties select lowest option ordinal. |
| Unanimous | Every elector responds with the same option. |
| Ranked | Threshold of distinct electors, complete permutations; Borda points `optionCount - position`, ties select lowest ordinal. |

No implicit abstention counts toward threshold. Each elector has one immutable response candidate; withdrawal is permanent and does not permit a replacement vote. Single, First and ChooseOne require threshold one. Unanimous requires threshold equal to electorate size.

## Concurrency and staging

DecisionEvent is an append-only journal bounded to 64 events. Unique `(decisionCase, ordinal)` and unique previous-event claims serialize competing commands. Schema rules require ordinal zero at the root, consecutive same-case predecessors, and forbid successors of terminal events. A response candidate becomes effective only when selected by a Responded event. Finalization pins the exact accepted response sequence and digest before appending its terminal event. Concurrent response, withdrawal, finalization and expiry competing at the same head cannot both append; the loser receives a conflict and must reread state. No custom Storage commit or `planFor` bypass is used.

Elector chains, options, response chains and outcomes are staged immutable rows. Interrupted opening may leave an incomplete case that fails closed. Losing commands may leave unselected candidates. They carry no decision authority; cleanup/retention is application policy. Depth bounds and generated reference rules constrain linked snapshots. Event deadlines use server-generated `createdAt`: Responded/Withdrawn/Finalized require it strictly before the deadline; Expired requires it at or after. This is the runtime planning timestamp, not a guarantee of wall-clock commit before the deadline.

With a caller idempotency key, create stages derive stable operation/depth/ordinal keys. Changed inputs conflict at the same stage; opening retries reuse staged rows while eligibility inputs remain unchanged. Accepted identical response retries return the existing event while the case remains open; withdrawal, finalization and expiry retries return the existing corresponding result. Failed races may be retried after reading state. Idempotency keys are command-scoped and must not be shared between distinct cases/commands.

## Authorization

All reads and creates use normal Engine.call policy, purpose, suppression, tenant and fence handling. Unique-claim presence lookup distinguishes a hidden journal row from absence, then calls authorized `.get`; hidden history fails closed. Participation proves eligibility, not actor authority. The application must authorize acting for a voter and opening/finalizing/withdrawing cases independently through its command and Gatekeeper policies. `recordedBy` is attribution, not proof of authority. Cross-tenant references are rejected by generated surfaces.

## Verification

`foundation-decision.test.ts` executes generated consumer artifacts with memory and SQLite adapters: six strategies, threshold checks, ranked tie, durable outcomes, finalize/withdraw race, raw fork/skip/terminal rejection, duplicate responses, backdated snapshot semantics, hidden event reads, denied writes, tenant isolation, evidence support, expiry/finalize competition, reconsideration, typed satellites, idempotent opening and malformed raw candidate rejection.

```sh
cargo run -q -p forgegraph-cli -- build packages/foundation/decision/fixtures/consumer --out /tmp/forge-decision-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/forge-decision-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-decision.test.ts
pnpm --filter @forgegraph/runtime typecheck
```

Live PostgreSQL, D1 and DynamoDB traces remain planned (`F39-STORE`). SQLite is local SQL evidence, not a claim of live D1 validation. Synthetic application fixtures establish usability, not application-repository dogfooding.
