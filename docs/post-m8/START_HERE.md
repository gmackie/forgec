# First engineering handoff

This document is a work order, not an assertion that the baseline code exists.

## First review

Establish which M0–M8 deliverables are actually implemented and collect their evidence. Freeze the M8 wire and scenario assets before changing compiler/runtime internals. FORGE-027 owns that inventory.

Review the next-edition decisions in plan section 2. In particular, preserve one-way sources; keep ordinary enums explicit and lifecycle states inferred; separate purpose taxonomy from grants; preserve runtime deny/intersection semantics; do not treat Effect services as a security sandbox.

## First implementation slice

1. Introduce versioned governance IR and nominal scoped service identities without changing old public artifacts.
2. Compile Contact capability fragments and ParentCommunication into a concrete field/action/query surface.
3. Provide the scoped reader from shared infrastructure clients without capturing user context in a process-scoped Layer.
4. Authorize each record access and serialize only approved fields; test a second unauthorized row, an old cached full record and a hidden-field query.
5. Execute the same scenario on D1, DynamoDB and PostgreSQL/Node. Preserve all applicable M8 integrity behavior.

Only after this path has evidence should the interface/registry teams advertise a generated tool as governed. Registry indexing and provider connection prototypes can proceed earlier, but cannot replace enforcement work.

## Work allocation

Compiler: FORGE-028–031, 037–041, 042–046.

Runtime/storage: FORGE-032–036, then shared enforcement work in FORGE-047–051.

Gatekeeper/security: review the threat model from the start; implement FORGE-047–051 before activation of catalog-driven actions.

Interfaces/registry/release: consume frozen public schemas, then implement FORGE-052–071. Prototype work must remain non-authoritative until upstream gates pass.

Provider/subject-rights/observability: FORGE-072–086, with privacy-safe baseline instrumentation retained throughout.

Certification and release: FORGE-087–091. Tests and fault injection are implemented alongside each feature, not postponed to this milestone.

## Do not start with

A universal registry UI; a new workflow engine; all database drivers; generated per-provider authorization logic; a fresh ORM; a mandatory hosted control plane; or an exhaustive world taxonomy. The primary deliverable is one correctly enforced, portable contract boundary.
