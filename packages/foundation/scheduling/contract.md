# scheduling contract

Issue #58; implementation acceptance remains planned.

## Ownership

Requirements, intersected candidate slots, appointment and rescheduling history. Allocation owns reservations.

## Composition

Required dependencies: availability, allocation, participation, place, fulfillment.

Routing selects assignees; Scheduling does not import Routing. Qualification-constrained booking is a separately gated bridge.

## Independent acceptance

Field visit/instrument/classroom; cross-zone intersection; two bookings sharing one resource; all-or-none reservation; release once; failed reschedule preserves prior booking.

- F58-01: requirement + candidate-slot model
- F58-02: multi-resource availability intersection
- F58-03: reservation/appointment lifecycle
- F58-04: participant/place integration
- F58-05: reschedule/cancel semantics
- F58-06: fixtures for field-service visit, lab instrument booking and classroom/meeting booking

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.

## Implemented bounded profile

`SchedulingRequirement` pins 1–16 distinct Allocation pools, exact required quantities, immutable Availability calendar revisions, a ParticipationSet, optional typed Participation members per need, and a Place. `search` intersects the pinned calendars across timezones; `slot` selects the exact required duration. Search windows are advisory with respect to capacity: booking validates the full capacity sweep. Participation membership must cover the complete slot at booking. The consumer chooses the participant-to-pool/calendar mapping explicitly.

`Appointment` is an inert durable intent with a unique caller key and a typed FulfillmentSet. Candidate reservations and membership nodes can be staged or abandoned without acquiring capacity. One `Engine.atomic` transaction commits all Allocation journal guards and the AppointmentCommit marker. The same transaction publishes prior AppointmentEnd when rescheduling; one Allocation `replace` journal action per common pool releases the old claim and acquires the new claim. Added/removed pools book/release in that transaction. A failed capacity check or final unique conflict preserves the old appointment in full. Cancellation atomically releases all pool claims with one unique terminal fact. Repeated identical commands reconcile against durable publication facts, including after a lost response and process restart. Different intent on the same key fails.

Publication reads validate the complete typed reservation set, expected journal command evidence, predecessor/successor publication, calendar intersection and current allocation lifecycle. Raw generated Appointment/Entry-like candidates and seals are not independent authority. A raw seal borrowing another appointment's reservations fails closed. Hidden terminals and dependency reads fail closed. Immutable historical appointments retain participant/place/FulfillmentSet references; changing membership later does not retroactively invalidate past booking facts. Fulfillment execution remains a separate business lifecycle and never silently releases capacity.

Bounds: 16 pools in the union of a reschedule, 512 journal entries per pool, 32 atomic mutation descriptors, Availability's existing 31-day query budget, and the actual provider's physical transaction budget. There is no staged-reference read overlay, same-record sequential composition, provider-spanning transaction, recurring appointment expansion, waitlist, qualification/routing inference, or atomic fulfillment execution claim. A read assembled during concurrent publication may fail closed and be retried; it is not a serializable multi-query snapshot. Staging candidates is not transactional with publication, and orphan cleanup is not included.

Local verification uses actual generated consumers and Engine operations against MemoryStorage, SQLite-backed D1Storage, and PostgreSQL 17. Tests include cross-zone intersection, typed field/lab/classroom consumers, Participation and real Fulfillment execution, shared-resource contention, same-key concurrent replay, failed reschedule preserving prior capacity, successful replacement, concurrent cancellation, crash before publication, lost response after commit, restart, tenant/authorization boundaries, hidden terminals and malicious raw seals. Cloud D1 and DynamoDB certification remains planned; SQLite does not establish live D1 guarantees.
