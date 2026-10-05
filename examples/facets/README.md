# Structural facets

`forgec build examples/facets --out examples/facets/generated` builds the
LevelForge-style Hazard and the business Customer/Supplier examples.

Facets contribute declared fields, defaults, refinements, and field annotations.
They cannot contribute identity, derived fields, uniqueness, lifecycle, queries,
or capabilities. Repeated applications and field collisions are errors.

The effective resource is an ordinary resource for storage, contracts, governance,
and runtime validation. `ir.modules[].facetOrigins` maps effective field anchors
to their declaring facet fields. Compiler `source_index` and `references` carry
build-local spans separately; file paths never enter DomainIR. `forgec lsp`
uses these to navigate from facet applications and effective-field expressions.
