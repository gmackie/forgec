# Business graph archetypes

`ConceptIR.archetypes` defines named semantic graph contracts and domain profiles.
The four fixtures bind the same RequestFulfillment graph to laboratory, factory,
telecom and software vocabulary. Role identity remains `request`, `specification`,
`fulfillment`, or `outcome`; display labels and aliases do not create new roles.

An archetype declares typed entity/fact/process roles, optional roles, structural
relationships, conjunctive contracts, lifecycle restrictions, output roles and an
explicit extension policy. A profile composes bases in separate namespaces, binds
roles to ordinary declarations, adds contracts and identifies local extensions.
It cannot override inherited contracts. Constraints on quantities/cardinality,
classifications and evidence use ordinary typed L0 predicates. The checker does
not claim to prove arbitrary logical implication: strengthening is additive.

`concept check` checks base conformance and the elaborated contracts. `concept
inspect` includes the normal elaborated ConceptIR, source map, and bound outputs
under `archetypes`. Each source map entry records the base, role or contract,
profile and application source anchor. Multiple profiles may bind the same node.
Generated names escape namespace separators; collisions fail rather than replace
an application declaration. Graph inspection includes elaborated relationships.
There is no runtime subtype hierarchy and no change to structural facets.

Lifecycle restrictions preserve the initial state and terminal guarantees and
allow only a subset of base transitions. They do not prove liveness. Optional
roles may be omitted only when no relationship, contract or output needs them.
A profile extension must reference an existing typed declaration; it cannot make
an invalid ordinary L0 graph valid. Consumers should retain the whole elaboration
envelope to preserve its source map alongside the executable-independent graph.

`concept diff` includes `archetypeChanges`: display rename, role rebinding,
added extension, strengthened constraint, broken contract, changed lifecycle
binding, or new composition. Changed/removed predicates and structural base
changes are conservatively reported as broken contracts, never presumed safe.
Runtime enforcement still requires the existing realization/assurance machinery.
