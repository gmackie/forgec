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
