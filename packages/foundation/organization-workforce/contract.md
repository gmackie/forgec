# organization-workforce contract

Issue #66; implementation acceptance remains planned.

## Ownership

OrganizationUnit hierarchy, pinned PositionSpecification, Position and temporal incumbency.

## Composition

Required dependencies: party, participation, specification, qualification, classification, place.

Availability expectations and Routing/Scheduling adapters follow core; no payroll/compensation substrate.

## Independent acceptance

Employee/crew/incident command; acyclic units; position != incumbent; qualification requirements; overlapping incumbency policy and race; place/classification refs.

- F66-01: organization unit hierarchy
- F66-02: position specification + position model
- F66-03: incumbency/participation relation
- F66-04: qualification requirements
- F66-05: place/classification integration
- F66-06: fixtures for employee org, production crew and incident-command structure

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.
