# Adjudication

Implements issue #44 using real Decision, Entitlement, Evidence, Evaluation, Fulfillment, Ledger and Delivery contracts. Typed ExpenseRequest, WarrantyRequest and HealthcarePreauthorization fixtures retain domain-owned request payloads; AdjudicationCase is not a universal claim entity.

## Context and determination

`Adjudications.open` pins an Entitlement, business coverage instant, known EntitlementEnd, requested decimal quantity/unit, 1–16 items, sealed Evidence, and a DecisionCase/approved option before Decision responses. Coverage is a historical knowledge snapshot: later backdated entitlement revocation does not rewrite the determination context. It does not consume entitlement quantity or implement cross-case aggregate limits. Business applications must authorize acting for the holder separately from eligibility.

`item` records each ordinal's requested quantity, completed EvaluationFinish and sealed Evidence before voting. Interpretation requires all pinned items and exact sum equal to the case request. Each Evaluation is an explicit selected item assessment; completion is operational evidence, not an implicit approval. Domain satellites own findings and evaluation-to-real-world provenance. `determine(case, authorized, reason, support, context)` requires authoritative Decision replay, selected outcome, all item evidence and positive authorization iff the approved option won. One unique Determination per case prevents contradictory terminal determinations. Reduced authorization is permitted; exceeding the request/coverage is not.

Cross-resource decimal limits use exact six-place BigInt arithmetic in helper validation because current generic row-rule decimal comparisons can be lexical. Explicit numeric row rules also enforce positivity where scalar exclusive bounds are insufficient. **Consumers must use `determination` and the downstream helpers**, which revalidate raw rows; a raw Determination row alone is not proof of a valid award. A malformed authorized raw insert can make a case fail closed, never authorize settlement through these helpers. Restrict raw write authority.

AdjustmentReasonLink associates a determination with its typed evaluated item and sealed source evidence. Reconsideration opens a separate case with new Decision history linked to an already determined predecessor. Old outcomes and settlements are never rewritten.

## Fulfillment, settlement and explanation

`authorize` creates an AuthorizedOutcomeLink to an existing Fulfillment only for a positive authoritative determination. This is authorization linkage, not evidence of execution, complete coverage or delivery. Lower Fulfillment owns those facts. Applications enforce domain-specific requested-service/executor semantics.

`planSettlement` freezes one SettlementIntent per determination with a LedgerBook, two distinct same-unit accounts and the **entire** authorized quantity. This bounded version supports one exact settlement, not incremental draws or multiple currencies. `settle` calls the authoritative Ledger.post with deterministic `adjudication:<intent>` identity and an exact balanced debit/credit pair, then adds SettlementLink. A failure after posting but before linking is explicitly resumable: Ledger's durable unique key reuses the posting and never posts twice. No side effect is claimed atomic with the link, and no posting is made before durable authorization/intent.

`settlement` revalidates the whole bounded Ledger book and exact posting identity/accounts/amounts. Raw unrelated or oversized posting links fail closed. Ledger owns reversal and financial history; a settlement link records the authorized posting, not an assurance that it was never subsequently reversed or externally paid.

`explain` links a DeliveryIntent to the determination and exact sealed support. It does not send a message, fabricate a receipt or promise provider exactly-once delivery. Domain adapters render the explanation content and Deliveries records actual attempts/outcomes. Every helper mutation uses normal Engine.call authorization, purpose, suppression, tenant and fence handling.

## Verification

Nine generated tests pass on memory, SQLite and local PostgreSQL 17: competing determinations, explicit rejection and oversized awards, partial positive award, source reasons, exact idempotent settlement with one group, invalid settlement quantity, all three domain wrappers, typed fulfillment and explanation intent links, retained coverage snapshot, tenant rejection, hidden determination read and denied reason mutation. Forge formatting, runtime typecheck and deterministic repeat consumer generation pass.

```sh
cargo run -q -p forgegraph-cli -- build packages/foundation/adjudication/fixtures/consumer --out /tmp/forge-adjudication-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/forge-adjudication-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-adjudication.test.ts
# FORGE_FOUNDATION_PG_URL adds isolated PostgreSQL traces.
pnpm --filter @forgegraph/runtime typecheck
```

F44-STORE stays planned: live D1 and DynamoDB are unverified. Local SQL/PostgreSQL evidence supports development composition, not provider certification or external payment/delivery claims. Domain fixtures are synthetic examples, not application dogfooding.
