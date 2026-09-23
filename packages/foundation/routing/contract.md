# routing contract

Issue #57; implementation acceptance remains planned.

## Ownership

Need/context, candidates, explainable assignment offer and accept/decline/expire history.

## Composition

Required dependencies: fulfillment, qualification, availability, allocation, participation, party.

Place/priority, workforce positions and appointment integration are upper-layer joins; no dependency on Scheduling or Workforce.

## Independent acceptance

Support/technician/reviewer/Bob; reject stale or expired eligibility; revalidate snapshot on accept; atomic capacity claim; competing accepts and expiry.

- F57-01: routing request/context
- F57-02: candidate eligibility from Qualification/Availability
- F57-03: capacity/allocation integration
- F57-04: explainable routing decision
- F57-05: assignment offer/accept/decline lifecycle
- F57-06: fixtures for support agent, technician, reviewer and Bob Runner/business assignment

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.
