# availability contract

Issue #55; implementation acceptance remains planned.

## Ownership

Calendar and immutable rule revisions; timezone-aware recurring windows, exceptions and overrides; optional authored specification pin.

## Composition

Required dependencies: specification.

Resource attachment is typed. Availability owns no capacity, reservation or appointment. Business clocks consume its query contract.

## Independent acceptance

Worker/machine/facility; bounded query, overnight window, DST gap/fold, leap date and precedence; replay old revision; allocation/scheduling bridge.

- F55-01: recurring availability rules
- F55-02: exceptions/overrides
- F55-03: timezone semantics
- F55-04: effective-window query
- F55-05: Allocation/Scheduling integration
- F55-06: fixtures for worker, machine and facility availability

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.
