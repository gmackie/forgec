# place contract

Issue #53; implementation acceptance remains planned.

## Ownership

Place identity, bounded containment, identifier set and typed address/timezone extensions.

## Composition

Required dependencies: identifiers.

PlaceAvailability bridge references Place and Availability; Place does not import Scheduling or Availability.

## Independent acceptance

Facility/room, customer site, warehouse; moves preserve identity; concurrent opposing moves cannot create cycles; invalid zones rejected.

- F53-01: stable Place identity
- F53-02: containment/hierarchy semantics
- F53-03: identifiers integration
- F53-04: address/timezone extensibility
- F53-05: fixtures for facility/room, customer site and warehouse location

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.

## Executable implementation

See [README.md](README.md) for the implemented resource/operation profile, explicit limitations, generated consumer fixture and focused memory/SQLite verification commands. Acceptance remains planned pending integration evidence; live provider certification is not claimed.
