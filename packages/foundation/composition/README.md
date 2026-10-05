# Specification and Instance Composition

Composition describes intended/current structure, independently of Lineage's
actual derivation history. CompositionSpecification pins meaning, ordering, cycle
policy and a fixed 0–16 slot count. A slot fixes component specification, unit,
quantity bounds, cardinality, temporal effectivity and 0–16 explicit alternatives.
Each substitution pins its own authority. Zero minimum cardinality is optional.

Instances bind a specification and optional ResourceSubject. Complete component
sets contain up to 16 distinct child instances. Each member names its slot,
quantity and ordinal. `Compositions.publish` validates a set and appends an
immutable effective revision against the exact previous head. Swaps publish new
sets; they never mutate old membership. Up to 64 revisions are supported.

`conform(instance, at, ctx)` selects the latest revision effective at that instant,
checks every active slot's member count and summed quantity, verifies permitted
specifications/substitutions, then recursively checks child instances. Ordered
profiles require nondecreasing slot order. Expired revisions do not reactivate
older ones. Slot and revision intervals are half-open. A leaf specification may
have an implicit empty composition until it has explicit revision history.

Traversal is bounded to 128 nodes and 16 levels. Cycles fail unless every profile
on the traversed path permits them; permitted cycles terminate as explicit
reference nodes rather than unbounded recursion. `specification` also validates
the complete intended graph, including every declared alternative. Partial or
unreadable slot, alternative or member sets fail closed.

Publication validates the graph at its start instant; conformance remains a live
query because other instances may later change or slots may cease to be effective.
There is no multi-instance snapshot claim. Raw revision rows must be interpreted
through conformance before use. Revision ordinals arbitrate competing swaps, and
history remains available by effective time. No runtime inheritance, stock
movement, commercial obligation or lineage fact is implied.

BOM assemblies, telecom service bundles, software packages and curricula are typed
consumer profiles. Local memory/SQLite/PostgreSQL tests cover optional slots,
alternatives, quantity, ordering, swaps/history, missing members and cycle policy.
