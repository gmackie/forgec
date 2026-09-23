# quotation-pricing contract

Issue #65; implementation acceptance remains planned.

## Ownership

Contextual quote/lines and immutable priced snapshot, revision/expiry/acceptance and agreement linkage.

## Composition

Required dependencies: agreement-catalog, specification, evaluation, ledger, party.

Party owns pricing actor context. Ledger supplies quantitative/value contract, not quote computation or automatic settlement. If value types move lower, remove Ledger edge explicitly at freeze. Domain Order/Selection joins remain above.

## Independent acceptance

SaaS/service/procurement; offer/spec pins; typed monetary and nonmonetary values; rate boundary and adjustment provenance; accept/expire race; issue agreement once.

- F65-01: quote + quote-line/snapshot model
- F65-02: offer/specification pinning
- F65-03: pricing/rate/adjustment extensibility
- F65-04: revise/expire/accept lifecycle
- F65-05: agreement/order integration
- F65-06: fixtures for SaaS, service quote and procurement quote

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.

## Implemented exact snapshot profile

PricingRate pins a policy SpecificationPin, explicit Ledger Account/unit, exact unit price and half-open effective interval. PriceAdjustment pins a policy, exact signed fixed amount and provenance reason. Immutable QuoteLine chains select 1–128 quantity/rate/optional-adjustment facts. Quote pins its Offer, buyer Party, exact offer terms, pricing instant, expiry, optional completed Evaluation and prior revision. Every read recomputes the complete frozen snapshot with BigInt. The fixed-rate profile requires quantity × rate to be exactly representable at six decimal places; fractional minor units reject rather than silently round. Adjustments must use the same unit and cannot make a line negative. Totals are separate per unit, supporting money and nonmonetary credits without implicit conversion. Ledger Account supplies unit identity; publishing or accepting a quote never posts or settles a Ledger group.

A unique immutable QuoteEnd serializes Accepted, Expired and Revised outcomes. Revision candidates are usable only when the predecessor's terminal selects them. Same-key publication compares the exact line snapshot and pins; orphan line/revision candidates are inert. Acceptance validates the offer-bound real Decision outcome, both signers and their Party/membership/votes, exact document and terms, and agreement interval. It prepares a server-timestamped AgreementAcceptance containing the exact command, then atomically creates the Accepted QuoteEnd and AgreementAcceptanceCommit through authorized Engine.atomic. The terminal stores the normalized command digest and intent reference. Both durable markers independently enforce offer/start windows; the terminal also enforces quote expiry. A delayed publication cannot borrow the preparation time. Null signer-end observations are fenced by serializable ParticipationEnd absence guards in the same atomic group; a concurrent revocation cannot publish acceptance. Recovery rereads terminal signer facts and rejects an end effective at or before acceptance, while a later end preserves the historical signing authority. The intent alone cannot be passed to Agreement recovery; an acceptance race loser leaves no commit or accepted terminal.

AgreementCatalog.acceptCommitted rechecks current authorization, real Decision/signatures and exact immutable pins, then creates the Agreement from its committed acceptance. Resuming after quote/offer expiry or the original agreement start does not reinterpret caller historical timestamps or move the original validity interval. Completion after contract expiry remains expired and grants no current agreement-mediated rights. Issuance uses deterministic receipt keys and a unique QuoteAgreement link. `agreement()` validates full issuance, matching intent/commit and the reconstructed command digest. Recovery with changed command, inaccessible authorization facts or an uncommitted intent fails closed. Lower-layer raw acceptance/commit creation requires its own write authorization and enforces the same original acceptance windows; it is not quote authority. Applications must use the quote trace for quote-governed fulfillment.

The accepted terminal and acceptance commit are atomic; subsequent Agreement creation and rights/duties issuance remain resumable stages. Prepared orphan intents grant no rights and can be retained as audit evidence. Existing terminals without an intent/commit cannot prove this historical authority and fail closed; they require explicit operator resolution or a new valid acceptance, never a backfilled timestamp. Schema changes add the two Agreement acceptance resources, nullable Agreement.acceptance and nullable QuoteEnd.intent; migrate storage before deploying the helper. Existing ordinary Agreements retain their original rules and require no rewritten history.

Generated memory, SQLite and local PostgreSQL tests cover exact money/credit totals, rate boundary rejection, adjustment unit mismatch, unsupported fractional minor units, immutable revisions, same-key replay, accept/revise contention, expiry, invalid signer preflight leaving the quote open, real completed Evaluation, issued Agreement recovery/replay with mismatched command rejection, typed SaaS/service/procurement consumers and an explicit domain Order link, hidden price provenance, tenant isolation and zero Ledger settlement. Percentage/tiered/tax/FX pricing, automatic order creation and Quote-to-Selection adapters are separately scoped extensions. Live D1/DynamoDB certification remains planned.
