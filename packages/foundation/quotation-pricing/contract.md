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

A unique immutable QuoteEnd serializes Accepted, Expired and Revised outcomes. Revision candidates are usable only when the predecessor's terminal selects them. Same-key publication compares the exact line snapshot and pins; orphan line/revision candidates are inert. Acceptance first validates the offer-bound real Decision outcome, both signers and their Party/membership/votes, exact document and terms, and agreement interval. The terminal stores a digest of the complete normalized immutable Agreement acceptance command. AgreementCatalog accept/issue then uses a deterministic quote-derived acceptance key, followed by a unique QuoteAgreement link. Issuance interrupted by authorization or infrastructure can resume without replacing price facts or creating duplicate agreements. `agreement()` is the authoritative complete trace: it verifies full issuance and reconstructs the command digest from the durable Agreement. A raw Accepted terminal alone is only pending issuance, not authority to fulfill or settle.

This forward-recovery protocol is not a cross-resource atomic creation claim. A retry before Agreement creation still must satisfy the catalog offer's current validity and proposed Agreement start; expiration or revocation during a long interruption can leave accepted pending issuance requiring operator resolution. No automatic rollback, acceptance cancellation or indefinite recovery guarantee is implemented. Accepted agreements already created can resume remaining issuance stages. Quote state/history and exact price snapshot remain inspectable throughout.

Generated memory, SQLite and local PostgreSQL tests cover exact money/credit totals, rate boundary rejection, adjustment unit mismatch, unsupported fractional minor units, immutable revisions, same-key replay, accept/revise contention, expiry, invalid signer preflight leaving the quote open, real completed Evaluation, issued Agreement recovery/replay with mismatched command rejection, typed SaaS/service/procurement consumers and an explicit domain Order link, hidden price provenance, tenant isolation and zero Ledger settlement. Percentage/tiered/tax/FX pricing, automatic order creation and Quote-to-Selection adapters are separately scoped extensions. Live D1/DynamoDB certification remains planned.
