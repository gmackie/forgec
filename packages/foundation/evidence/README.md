# Evidence (experimental)

Applications attach EvidenceBundle sidecars; Evidence never stores an arbitrary
subject type/id or a generic verdict. EvidenceSource is a source-specific handle.
`sourceRecord` identifies an observation within that source; typed domain satellites
provide richer source and measurement details. `observedAt` records observation
time while generated timestamps record ingestion. Artifact evidence pins an exact
immutable ArtifactRevision and its digest, checked even on direct create.

Items are append-only **candidates**, not automatically the sealed support set.
EvidenceMember forms an immutable typed chain within one bundle. Its strictly
decreasing integer rank (1 through 128) bounds traversal and excludes cycles.
EvidenceSeal uniquely pins a bundle to one exact chain head, including an empty head.
Competing seals conflict atomically. Adding candidates or other chains after sealing
cannot change its membership. This avoids a race-prone check-then-append protocol.

`Evidence.items` lists candidates. `Evidence.sealedItems` reads only sealed membership
and rejects unsealed bundles. Every member, item, source and artifact revision must
be readable; a hidden seal never means an open bundle. Missing or denied support
fails closed rather than returning a partial support set. `seal` validates the chain
before writing the unique immutable seal. Repeated items are permitted as ordered
references; no aggregate measurement is inferred from membership.

`successor` creates a new bundle referencing a predecessor EvidenceSeal. Corrections
record new items and select a new chain; old support remains unchanged. Successors
are explicit branches, not an implicit mutable latest pointer. Direct schema writes
still enforce same-bundle chains, bounded rank, unique seal and append-only history.

Provenance is classified `EvidenceNarrative extends data.communication.content`.
That annotation describes meaning, not access: normal independent Engine/Gatekeeper
policies must protect bundles, items, sources, typed details and artifact content.
The helper reauthorizes all returned support records. This initial release does not
claim automatic inherited policy or automatic classification-based access control.

Generated fixtures exercise deployment verification, manufacturing inspection and
agent review with typed measurement satellites. Local memory/SQLite tests are not
hosted D1/PostgreSQL/DynamoDB certification. Shared catalog/runner registration and
fixture refresh are owned by the integrator.
