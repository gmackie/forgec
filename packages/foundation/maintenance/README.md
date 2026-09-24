# Maintenance

MaintenanceWorkOrder composes an AssetProfile, admitted Demand conversion and its
Fulfillment, technician requirement, optional Routing/Scheduling and Operations
links, fixed parts set, and pinned inspection/acceptance decision. Domain profiles
cover industrial, fleet, medical and network work without making WorkOrder a
runtime Task.

Preventive orders bind a recurring UTC-day MaintenancePlan and unique cycle.
Their demand start must equal anchor plus `(cycle - 1) * intervalDays`. Condition
orders require a breached Measurement assessment; corrective orders require sealed
defect evidence; inspection-only orders cannot consume parts. Calendar expansion
and automatic work generation are separate orchestration responsibilities.

`Maintenance.inspect` validates the converted demand, exact execution definition,
qualification covering the full work interval, published routing assignment and
optional appointment, and Operations usage from the linked execution run. Routing
history remains inspectable after release. It does not imply current assignment
eligibility; Routing.consume remains the live execution check.

Each of up to 16 parts must reference a distinct admitted Inventory issue in the
work interval. Partial or hidden parts fail closed. Inventory owns reservations
and atomic consumption; the maintenance link cannot manufacture stock movement.
Labor/resource actuals come from the linked Operations Usage stream.

`finish` requires complete Fulfillment, the pinned completed/unquarantined
inspection, sealed evidence and a Decision selecting the prebound accepted option.
Return-to-service names a validated Asset commissioning event after inspection
and acceptance. Alternatively it records follow-up Demand; inspection-only work
may finish without either. Commissioning establishes readiness; operation is a
separate Asset action. This API verifies already established facts and does not
silently reactivate equipment or bypass the asset's attestation policy.

`history` lists at most 128 candidate work orders for the asset; use `inspect` to
validate their execution and finish authority. Work order and cycle facts are
immutable; unique finish and plan/cycle identities prevent duplicate closure.
Local memory/SQLite/PostgreSQL tests exercise all triggers, qualified routing,
parts, labor, inspection acceptance, return-to-service and domain consumers.
