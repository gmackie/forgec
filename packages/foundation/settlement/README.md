# Settlement

Experimental `@forgegraph/foundation/settlement` implements neutral outstanding
positions under quantified Obligations. The same position is a receivable to its
creditor and a payable to its debtor. It is neither an adjudication request (#44),
an invoice, nor a ledger entry. Typed commerce, reimbursement and service-minute
credit fixtures exercise the common vocabulary without standardizing domain nouns.

## Authority and source admission

Use `new Settlements(engine, admission)`; every nonempty authoritative read and
publication requires the explicit trusted `SettlementAdmission` callback. A key or
caller-supplied amount alone is never payment/performance proof. The callback reads
an application-owned **typed, immutable, timestamped** native occurrence satellite
through normal authorized Engine operations. It must check the source kind, exact
quantity, unit, Parties, obligation/Agreement scope, and the permitted amount on
**each** allocation. It receives normalized `{position, quantity}` allocations,
effective time and knowledge time; the source contains occurrence time. During
historical validation knowledge time is the original **commit seal's createdAt**.
Proof recorded after that instant must fail closed, even when later discovered.
An admission call without allocations verifies the native source before staging.

The fixture's EconomicOccurrence binds a unique FulfillmentEnd to measured quantity,
unit, creditor, debtor and obligation scope; its admission callback verifies those
fields and proof chronology. Applications must bind that occurrence to their actual
native payment/delivery identity with durable uniqueness and trusted measurement.
Do not create fresh Fulfillment occurrences to represent the same native payment.
The library cannot infer native economic identity, exchange policy or measurement
from a bare FulfillmentEnd. Restrict native-occurrence creation to the trusted
application ingestion boundary, and keep callback policy/version stable or treat
policy changes as explicit authority changes. No callback means fail closed.

SettlementSource requires a unique completed FulfillmentEnd for both performance
and payment. This uniqueness spans all books in the tenant: changing source key,
kind or book cannot spend the same fulfillment again. One commit consumes one
source, and its 1–16 distinct-position allocations must sum **exactly** to the source
quantity in one unit. Partial obligation materialization and partial payment use
separate admitted occurrences. Splitting one source over multiple independently
committed events is deliberately unsupported; allocate its entire quantity across
positions in one event. A reversal does not make its source spendable again.

## Package relationships

Dependencies: Party, Entitlement/Obligation, Fulfillment, Agreement/Catalog and
Ledger. A position pins one positive quantified Obligation; its debtor, unit,
ceiling and dueAt must match. One position per obligation prevents cap duplication.
Creditor is explicitly admitted by domain source policy, never inferred from an
invoice. An ended obligation cannot admit an event at/after its effective end.
Absent ObligationEnd is checked atomically with publication, preventing a racing
cancellation from admitting new economic effects.

The optional Agreement reference requires a real issued Agreement validated by
AgreementCatalog at the obligation's incurredAt, with matching supplier/creditor,
customer/debtor, offer requirement and scope. Catalog issuance creates an
**unquantified** duty; it is not silently rewritten into a quantified obligation.
A domain instead admits a distinct quantified obligation for the agreed performance
condition, links the actual Agreement, and validates that relation in source policy.
The fixture executes actual offer selection, both signer responses, finalization,
acceptance and issuance before using this bridge. Agreement-derived rights are not
invented from Party membership or a raw Agreement row.

`linkLedger` validates a separately published Ledger group and creates a typed
association. It does not post accounting entries or infer settlement from them.
Reversing a Ledger group leaves the settlement position unchanged, and reversing a
settlement event does not implicitly reverse accounting. Accounting policy and its
own exact balanced postings remain explicit caller work; the two publications are
not a distributed transaction. InvoiceRepresentation similarly only references the
position and owns no balance.

## Publication and quantities

`openPosition`, `admitSource`, `materialize`, `settle`, `reverse`, `inspect` and
`linkLedger` are the runtime API. `materialize`/`settle` take book, stable event key,
source ID, occurrence/effective instants, reason and normalized allocation lines.
Same-key replay requires the same full command, including line order and reason;
changed payloads fail. Sources use stable native-admission keys.

Immutable lines and event headers are candidates. A single immutable
SettlementCommit publishes the whole event with unique `(book, ordinal)`,
`(book, key)` and source identities. Concurrent contenders for the next ordinal
cannot both publish; all positions in one event become effective together. A losing
caller can retry its same command against the new state. Uncommitted candidates
have no economic effect and may remain after denial, crash or a race. No mutable
balance cache is trusted. Direct raw publication is not proof: every helper read
revalidates chains, source admission, amounts, causal ordering and positions, and
fails closed on forged publications or hidden facts.

All quantities use six decimal places and BigInt arithmetic. For **every** prefix
ordered by effectiveAt then durable commit ordinal:

```
0 <= settled <= materialized <= obligation.quantity
remaining = materialized - settled
```

A future-effective event reserves its eventual place in that schedule; a backdated
or later correction cannot make any intervening prefix negative. Source occurrence
cannot predate the underlying obligation and the economic effect cannot predate
its source occurrence. There is no implicit currency conversion or cross-unit
aggregation. The profile permits at most 512 commits per book and 16 lines per
event; exceeding the budget fails closed. Reads reconstruct a bounded observed
history, not a globally serializable snapshot during concurrent publication.

## Temporal explanations and corrections

`inspect(position, {asOf, knownAt?, party?}, ctx)` derives quantities from events
whose effectiveAt is at/before asOf and whose **commit createdAt** is at/before
knownAt. The position itself must already be known. Boundaries are inclusive;
equal effective timestamps use commit ordinal, and equal knowledge timestamps
include all seals at that timestamp. The returned explanation retains occurrence,
effective and publication times, amount and reversal source. Due time is the
Obligation's immutable dueAt; overdue means a positive remaining amount at/after
that instant. Staged event creation time is never knowledge of economic effect.

Reversal publishes the exact original lines with opposite effect, once, no earlier
than the original effective time. Nested/repeated reversals fail. Materialization
already consumed by settlement cannot be reversed until its dependent settlements
are reversed. Correction is a reversal followed by a separately admitted new event;
those two commands are separately atomic, not one combined correction transaction.
Original events and source proof remain immutable and readable.

Knowledge filtering is bounded accounting history, **not historical authorization
replay**. Current access and upstream Agreement/Decision authority are rechecked.
A later backdated authority invalidation or unreadable upstream fact can make even
a past `knownAt` query fail closed; it never silently recomputes or erases the old
balance. Raw facts remain history subject to normal read authorization. Settlement
publication serializes amounts and guards ObligationEnd absence; it does not promise
atomic admission against every concurrent external policy/Agreement revocation.
The domain admission bridge owns such additional constraints where needed.

These explicit package-level times do not implement #75 semantic compiler or
ConceptIR integration. `F80-SEMANTIC` remains planned, as does `F80-STORE` until
source-bound full-profile receipts pass on PostgreSQL, hosted D1 and DynamoDB.
Local memory/SQLite/PostgreSQL traces are not hosted certification or deployment.

## Independent verification

Build the real consumer closure, then run focused tests:

```sh
cargo run -p forgegraph-cli -- lock packages/foundation/settlement/fixtures/consumer
cargo run -p forgegraph-cli -- build packages/foundation/settlement/fixtures/consumer --out /tmp/foundation-settlement
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-settlement \
  pnpm --filter @forgegraph/runtime exec vitest run test/foundation-settlement.test.ts
```

Set `FORGE_FOUNDATION_PG_URL` to include isolated PostgreSQL schemas. Tests cover
three typed domains, temporal/replay/reversal behavior, competing/multi-position
publication, source reuse, source allocation and knowledge validation, actual
Agreement and Ledger bridges, current-authority denial, raw bypass rejection and
atomic obligation cancellation. Tests require no external payment/provider effects.
