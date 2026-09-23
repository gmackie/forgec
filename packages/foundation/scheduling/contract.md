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
