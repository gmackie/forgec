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

## Implemented explainable assignment profile

RoutingRequest pins one QualificationRequirement, an interval, an exact quantity/unit, ParticipationSet and FulfillmentSet. RoutingResource explicitly maps a qualification subject, optional Party, FulfillmentExecutor, AllocationPool and immutable Availability calendar revision. Domain satellites supply support-agent, technician, reviewer and Bob Runner identity. RoutingCandidate records the exact matching qualification, optional typed participation, evaluation time, caller-owned rank and rationale. Ranking vocabulary and policy remain with the application; there is no implicit authorization, optimization or workforce lookup.

`evaluate` and `offer` verify the subject's qualification now and through the full requested interval, calendar coverage, explicit units and any participant binding. `accept` revalidates the pinned qualification snapshot and offer expiry, then atomically commits the pool journal, unique offer outcome and unique request assignment through Engine.atomic. Competing request assignments and expiry/decline facts cannot leave a losing capacity claim. Repeated accept resolves the same durable assignment; `consume` revalidates current eligibility and publication evidence. `attachExecution` checks a real Fulfillment against the assigned executor and requested FulfillmentSet.

A revocation can race between eligibility read and acceptance commit: the current kernel does not atomically guard absence of QualificationRevocation or ParticipationEnd. This profile intentionally does not claim serializable eligibility. An assignment that loses eligibility cannot be consumed; `release` remains available without qualification and atomically writes AssignmentEnd plus the pool release. This durable invalidation/release path is necessary because an eligibility race may leave allocated capacity even though accept reports failure after its post-commit revalidation. Stronger atomic eligibility guards remain pending. The assignment pins its calendar revision; discovering and replacing newer calendar versions is an upper-layer policy.

Bounds and limits inherit Allocation's 512-entry journal and Availability/Qualification lookup budgets. One resource/pool is assigned per request; offers can compete across resources. Resources, offers, explanations and lifecycle facts are append-only; raw candidate or assignment records do not become consumption authority without validated offer and allocation evidence. Hidden terminal facts fail closed. Fulfillment execution is separately linked and does not implicitly release capacity. Offer expiry is checked at acceptance validation and terminal publication; this profile does not implement a provider-clock commit-time expiry predicate.

Verification uses generated consumers with memory, SQLite and local PostgreSQL 17. Cases cover all four domain wrappers, actual Qualification→Routing and Availability→Routing composition, Participation, real Fulfillment linkage, same-key concurrent accept, capacity conflict, competing resources for one request, decline, expiry racing acceptance, raw stale eligibility, authorization/tenant isolation, restart, and a revocation injected exactly between validation and atomic commit followed by safe consumption rejection and durable capacity repair. Live D1/DynamoDB certification remains planned.
