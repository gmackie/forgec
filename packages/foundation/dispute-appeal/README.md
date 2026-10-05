# Dispute / Appeal

A ContestedFact links exactly one admitted DecisionOutcome, issued BillingCharge,
verified Finding, or terminal FulfillmentEnd. Dispute adds a separate Case,
appellant, grounds, sealed evidence, requested remedy, jurisdiction, policy,
filing/review deadlines, a review EvaluationRun, and four distinct Decision options.
The original remains immutable. This is review of an existing fact, not initial
adjudication.

ReviewMandate is an evidenced authority assertion binding a reviewer Participation
to jurisdiction and policy over a validity interval. Its authorized writers own
that assertion. Membership alone does not grant review authority. A terminal end
revokes the mandate; readers fail closed on hidden ends. This initial profile uses
one mandated reviewer and the Decision Single rule. Domain policy governs which
authority may issue a mandate and admissible grounds.

`Disputes.inspect` checks the original publication, case, pins, sealed evidence,
mandate, reviewer eligibility and decision deadline. `result` also requires a
completed, unquarantined evaluation before the admitted decision, the selected
uphold/modify/reverse/remand option, and a still-valid mandate at decision time.
An appeal links both previous Dispute and its validated result, preserves appellant
and contested fact, advances level, and cannot predate the prior result. Chains
are bounded at eight levels.

`remedy` is separate: complete Fulfillment of a pinned implementation, issued
Billing adjustment to the exact contested charge, or completed Change. Uphold
cannot carry a remedy. Remand may link separate work for a new review; it does not
silently create it. Policy-specific amounts, consent and remediation semantics
remain domain extensions. Billing settlement and ledger postings remain separate;
no decision transfers money or mutates the original record.

Billing, benefits, moderation and quality consumers reuse this system. Tests run
on memory, SQLite and PostgreSQL and exercise all four outcomes, recursive appeal,
mandate revocation, incomplete remedy rejection, preserved original decisions,
deadlines and tenant isolation.
