# Capability and Capacity

A capability pins what a provider can deliver, its quantitative dimension/unit and
qualification requirement. A provider binds a QualificationSubject, optional typed
ResourceSubject, and exact Availability calendar revision. Domain satellites can
bind workers, machines, resource sets or service identities to that provider.

Capacity records keep planned, forecast and actual quantities separate. Each has
an immutable interval, place, scope pin and Allocation pool. The capacity amount
may differ from the reservation pool ceiling: observed degradation must remain
visible even when existing commitments exceed actual capacity. Zero is valid.
No capacity record changes the pool or authorizes reservations.

`Capacities.project(id, at, ctx)` returns exact six-decimal amounts for one
minute-aligned instant within the half-open interval:

- `amount`: the recorded quantity for that basis;
- `available`: amount when qualified and within the pinned availability window;
- `committed`: active Allocation claims, including unexpired holds;
- `remaining`: available minus committed (may be negative);
- `demanded`: active compatible demands in the fixed application set;
- `unapplied`: demanded quantity without an active linked reservation;
- `gap`: max(unapplied minus remaining, zero).

A linked committed demand is not charged twice. Claims without linked demands
still consume remaining capacity. Cancellation/supersession excludes demand;
conversion alone does not imply its delivery. Release removes the commitment.
The returned Allocation head identifies the authority observed. This is a bounded
read projection, not a transaction snapshot or historical reconstruction. Allocation
continues to own all races and oversubscription enforcement.

Each interval fixes 0–16 applications. Unique ordinals and complete membership
checks reject partial or unreadable application sets. Demand must share the
capability specification, unit and place and fit inside the capacity interval.
Optional reservation links must match its pool, interval and quantity. Calendar
precision is one minute; qualification is evaluated at the requested instant.
Quantities represent simultaneous capacity, not integrated throughput over time.
The API does not perform implicit unit conversion or sum different providers.

`compare(plannedOrForecast, actual, at, ctx)` requires matching provider,
capability, unit, scope, place and interval and returns actual-minus-expected
variance. Manufacturing cells, hospital services, cloud regions, network circuits
and field territories are typed consumer fixtures. Tests run against memory,
SQLite and PostgreSQL; they do not certify hosted adapters.
