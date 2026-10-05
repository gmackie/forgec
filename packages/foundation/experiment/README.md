# Experiment

Experiment pins an exact protocol definition, assignment method, seed, optional
AllocationPool and 1..16 immutable variant definitions. All ordinal slots must exist
before assignment; fixed slot count and unique ordinals prevent later replacement
or extension. Amendments create new experiment revisions with increasing ranks.
Manual assignment requires an explicit variant. SeededHash selects the first eight
hex digits of SHA-256(JSON.stringify([seed, subjectKey])) modulo variant count.
This reproducible convention is not cryptographic random sampling or balance control.

ExperimentAssignment candidates record subject identity, provenance, optional typed
Participation and optional unique reservation. Accepted assignments are selected by
a 128-event append-only ExperimentEvent journal. Unique experiment/subject identity
and retry reconciliation deduplicate concurrent assignment. Assigned and terminal
Closed/Cancelled events share the same next ordinal, so closing cannot be bypassed
by a late assignment. Reassignment requires a new experiment amendment; immutable
subjects cannot silently change variants or reservation identity.

Scarce assignments use real Allocation reserve/allocate commands and retain the
exact allocate journal grant in their acceptance event. State validates the entire
Allocation journal before trusting that provenance. A historical accepted assignment
does not imply the resource is still allocated; consumers must inspect Allocation
before current use. These systems are not a distributed atomic transaction: failed
publication after allocation leaves a visible pending allocation that an operator
must explicitly release. It never yields capacity to a second claimant silently.

Typed intervention links pin Fulfillment to variant definitions. Evaluation links
pin completed runs and sealed evidence, while domain Accuracy and other satellites
own outcomes. Artifact links retain exact ArtifactRevision and LineageNode identity.
Real blob upload/finalization/publication is exercised; no arbitrary JSON payloads
or generic entity references are introduced. Optional participant identity conveys
provenance, not consent or kernel authority.

Synthetic A/B, LLM comparison, LevelForge comparison and manufacturing DOE consumers
pass on memory, SQLite and local PostgreSQL. Traces cover duplicate and competing
scarce assignments, seeded retry, variant boundaries, closure, typed evaluation and
intervention, artifact publication, lineage and denied/cross-tenant access. Hosted
D1/DynamoDB remain unverified; F42-STORE remains planned.
