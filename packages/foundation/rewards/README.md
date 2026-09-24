# Rewards / Incentives

RewardProgram pins specification, eligibility, earning rules and an existing
Catalog. Membership binds a Party to a points account. A RewardClaim identifies
one immutable Usage event or completed Fulfillment outcome, preventing repeated
claims for the same member/behavior. Behavior is evidence, not an award.

An award needs completed, unquarantined evaluations of both pinned rules plus an
accepted Decision after those evaluations. Domain evaluators own eligibility and
the earning formula. The reader checks their provenance and approval; it does not
execute SpecificationPin text. Awards preserve the original behavior snapshot;
later Usage corrections require an explicit reward reversal/correction.

Points must exactly match a published balanced Ledger transfer from the program
funding account to the member account, in one book/unit. Nonfungible benefits use
an unquantified Entitlement for the member. `Rewards.state` validates evidence,
accounting and availability. Ledger.inspect exposes authorized group entries and
reversal provenance for composition, retaining Ledger's own bounded validation.

`end` validates one unique terminal disposition per award. Redemption consumes a
whole award, links an Offer in the program Catalog and completed separate
Fulfillment, and requires an exact points debit or explicit benefit end. Expiry
requires the deadline and matching disposal facts. Reversal exactly reverses the
original Ledger credit or ends the benefit. A corrected award shares the claim,
advances revision, and requires a validated prior reversal; chains stop at eight.
Partial redemption and proportional correction are domain extensions, not implied
by this whole-award profile.

Ledger transfers and fulfillment are separately authorized published facts.
This service does not send rewards or mint points. Hosts own their execution and
must reconcile a prepared accounting effect if terminal publication fails. The
unique terminal prevents double consumption inside this system; it does not
promise atomicity across an external reward provider. External reversals make
points unavailable and cannot be hidden by a successful reward record.

Customer loyalty, employee incentive, referral and education profiles share the
model. Three storage backends test exact points validation, benefit expiry,
incomplete redemption rejection, competing redemption claims, reversals,
corrections and tenant isolation.
