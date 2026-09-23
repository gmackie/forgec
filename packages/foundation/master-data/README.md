# Master Data

Master Data owns resolution-specific SourceRecord and CanonicalRecord handles.
Domain resources retain concrete customer, supplier and asset types; no targetType,
universal EntityRef or JSON entity is introduced. ResolutionDomain separates mapping
families. Source identifiers use the Identifiers namespace/issuer/value uniqueness
contract. Each source handle has one exact identifier and a lineage node.

A ResolutionCase pins a completed EvaluationRun/Finish, the DecisionCase assessing
that finish, candidate canonical record, and exact Reconciliation desired revision
and publication. Desired provenance is a snapshot, not a cross-system transaction
or a claim that desired intent remains current forever. ResolutionChoice binds an
immutable decision option to the candidate. SurvivorshipDecision binds that choice
to a finalized DecisionOutcome and exact source-to-canonical LineageRelation.
The runtime validates the complete Decision state before merging and whenever it
reads authoritative mappings; fabricated raw decision candidates fail closed.

CanonicalLink is a source-scoped append-only mapping journal, bounded to 128 events.
Initial mapping is followed by Merge and Unmerge records. A unique source/ordinal
claim and exact predecessor rules serialize competing merges. Stale publication
fails; retries with a stable Engine idempotency key return the original event.
Unmerge must immediately follow the merge being reversed and restores its exact
previous canonical target without deleting history. Further independent corrections
need new decisions. This is mapping resolution, not destructive physical merging of
domain rows, global canonical redirects, or atomic bulk merging of many sources.

All resources are tenant-scoped. Hidden mapping or decision history fails closed.
Generated rules protect reference consistency, domain boundaries, journal shape and
immutable history; consumers must use MasterData.state for validated authority,
rather than treating raw candidate or link reads as a decision verdict.

The imported consumer exercises customer, supplier and asset cases using real lower
packages. Memory, SQLite and local PostgreSQL tests cover identifier collisions,
wrong typed references, decision/lineage composition, competing merges, restoration,
retry, stale replay, tenant isolation and denied access. These are synthetic contract
fixtures, not application dogfooding. Hosted D1 and DynamoDB remain unverified.
