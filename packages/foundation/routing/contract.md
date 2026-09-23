# routing contract

Issue #57; bounded local implementation. Hosted provider certification remains separate.

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

## Implemented explainable assignment profile

RoutingRequest pins one QualificationRequirement, an interval, an exact quantity/unit, ParticipationSet and FulfillmentSet. RoutingResource explicitly maps a qualification subject, optional Party, FulfillmentExecutor, AllocationPool and immutable Availability calendar revision. Domain satellites supply support-agent, technician, reviewer and Bob Runner identity. RoutingCandidate records the exact matching qualification, optional typed participation, evaluation time, caller-owned rank and rationale. Ranking vocabulary and policy remain with the application; there is no implicit authorization, optimization or workforce lookup.

`evaluate` and `offer` verify the subject's qualification now and through the full requested interval, calendar coverage, explicit units and any participant binding. `accept` revalidates the pinned qualification snapshot and offer expiry, then atomically commits the pool journal, unique offer outcome and unique request assignment through Engine.atomic. Competing request assignments and expiry/decline facts cannot leave a losing capacity claim. Repeated accept resolves the same durable assignment; `consume` revalidates current eligibility and publication evidence. `attachExecution` checks a real Fulfillment against the assigned executor and requested FulfillmentSet.

Acceptance guards the absence of QualificationRevocation and ParticipationEnd by
unconditional unique key in the same transaction as capacity and assignment. A
terminal inserted after eligibility validation aborts the entire group; no Assignment,
accepted offer outcome or capacity debit survives. Existing immutable terminal facts
that take effect at or after the requested interval remain valid for that interval.
The guard requires unfiltered read authority and provider support; hidden facts or
unsupported adapters fail closed.

A revocation committed after acceptance can still invalidate an assignment. `consume`
rechecks eligibility, and `release` remains available without qualification to write
AssignmentEnd and release capacity atomically. The assignment pins its calendar
revision; discovering and replacing newer calendar versions is an upper-layer policy.

Bounds and limits inherit Allocation's 512-entry journal and Availability/Qualification lookup budgets. One resource/pool is assigned per request; offers can compete across resources. Resources, offers, explanations and lifecycle facts are append-only; raw candidate or assignment records do not become consumption authority without validated offer and allocation evidence. Hidden terminal facts fail closed. Fulfillment execution is separately linked and does not implicitly release capacity. Offer expiry is checked at acceptance validation and terminal publication; this profile does not implement a provider-clock commit-time expiry predicate.

Verification uses generated consumers with memory, SQLite and local PostgreSQL 17. Cases cover all four domain wrappers, actual Qualification→Routing and Availability→Routing composition, Participation, real Fulfillment linkage, same-key concurrent accept, capacity conflict, competing resources for one request, decline, expiry racing acceptance, raw stale eligibility, authorization/tenant isolation, restart, and qualification revocation/membership termination injected exactly between validation and atomic commit, proving rollback without capacity repair; future-effective terminal facts remain usable. Live D1/DynamoDB certification remains planned.
