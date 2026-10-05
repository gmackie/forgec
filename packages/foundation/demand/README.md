# Demand / Request

Demand records quantity, exact capability/constraint/priority-policy pins, requester, place,
time window, priority and source provenance. Service, replenishment, staffing and compute
payloads remain in typed domain resources. Inferred signals require sealed evidence;
explicit requests can additionally bind to an accepted Intake submission. A policy pin
records the priority's source; this system does not evaluate arbitrary prioritization policy.

A DemandGroup contains 1–16 fixed, uniquely numbered members sharing specification,
constraints, units, place and the complete time window. `Demands.aggregate` verifies every
member is readable and returns open demand sorted by priority with exact decimal totals.
Incomplete groups fail closed. Groups are views over original requests, not new demand:
a request may appear in several planning groups but can resolve only once. A bounded group
can be rebuilt with a different membership; its append-only history remains unchanged.

DemandResolution serializes cancellation, supersession and conversion on a unique demand
key. Supersession preserves requester and capability and points strictly forward in creation
time. Conversion binds an exact-specification Fulfillment. `convertGroup` atomically publishes
all open members' conversions; cancellation racing any member aborts the whole batch.
Callers stage their typed Fulfillments first and must consult the committed resolutions:
an unlinked staged Fulfillment is not evidence that Demand converted. After conversion,
cancellation is owned by Fulfillment and its downstream systems, not a second Demand outcome.

DemandAllocation binds matching quantity, units and window. Its reader returns Allocation's
validated phase; a reservation row alone is not capacity ownership. DemandSchedule binds
an actual converted demand, its FulfillmentSet, slot, place and requirement and reads
Scheduling's publication/termination facts. DemandRoute binds the converted work to an exact
RoutingRequest; Routing retains qualification, offer and assignment authority. Planning links
never authorize work or infer booked capacity. Domain adapters use the normal Allocation,
Scheduling and Routing services to perform those transitions.

Tests cover explicit and forecast domain profiles, incompatible/incomplete groups, exact totals,
cancellation versus atomic batch conversion, supersession, allocation ownership, committed
scheduling/cancellation, routing links, tenant isolation and hidden terminal facts across
memory, SQLite and PostgreSQL. Demand is not a work-queue Task and has no generic JSON payload.
