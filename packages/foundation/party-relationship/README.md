# PartyRelationship

Typed, temporal Party-to-Party facts using ConceptIR Relationship semantics (#77).
Definitions pin the domain vocabulary to an exact SpecificationPin and retain different
forward/inverse labels. A relationship has typed Party endpoints, an optional typed scope,
source provenance and an optional sealed Evidence reference. Domain consumers add stronger
vocabulary constraints: employment, corporate ownership, guardianship and supply fixtures
bind their definition and endpoint/validity witnesses to the same authoritative record.

The authored `fixtures/relationships.concept.json` declares each domain profile as a
ConceptIR Relationship with typed Party endpoints and valid-time bindings. CLI regression
tests compare these declarations with compiled consumer entities and reject wrong endpoint
types. There is no second generic relationship type system. The runtime helper only reads
and writes this Foundation profile's records. ConceptIR declaration checks do not claim
provider enforcement; the runtime tests verify the storage rules separately.

`PartyRelationships.record`, `current`, `listAt` and `end` use authorized dependency reads.
Inverse views return the original relationship ID. Both interval endpoints and terminal
facts use half-open validity. Unique terminal facts serialize concurrent endings; replacement
must retain definition, endpoints and scope and start strictly later at the ending instant.
Historical reads remain available. Hidden termination facts fail closed. Ended replacements
are not automatically followed or resurrected. Consumers must exhaust list cursors, including
empty filtered pages, and read each candidate at the required instant.

Domain profiles are created after the authoritative relationship. A failed profile write
leaves a relationship with no domain profile; it does not confer that profile's meaning.
The package intentionally does not import Participation, Delegation or Entitlement. Employment,
ownership or guardianship facts grant no runtime permission. Applications must explicitly
establish scoped memberships, delegated authority and entitlements through their own systems.
