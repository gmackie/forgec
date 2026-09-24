# Adaptive Case Management

Case is a durable responsibility envelope, with typed CaseSubject, pinned context,
reason, initial owner, participants and opening time. Domain satellites supply
support, healthcare episode, investigation and legal vocabulary. It is a Foundation
system, not a ConceptIR primitive or runtime workflow/task.

CaseFile links sealed Evidence and/or an ArtifactRevision. CaseInteraction binds a
bounded engagement to a Collaboration thread with the case's participants. Typed
journal actions attach those records, Decisions, Fulfillments, related cases and
escalations in any order while the case is open. Creating a candidate does not
admit it into case history. No prescribed linear process is required.

`Cases.state` reads a complete consecutive history (up to 128 actions), authorizes
every referenced detail and returns current owner/closed status plus the exact
head. `Cases.act` requires that head as `previous`. Unique ordinals arbitrate
concurrent edits: only one close, transfer or ad-hoc activity wins a stale head.
A closed case accepts only reopening; original closure/history is preserved.
Transfers name a new Party and remain auditable. Escalation links another case;
it does not silently transfer responsibility or send a notification.

CaseMilestone pins entry criteria, a completed Evaluation under that definition,
sealed evidence, and a Decision with the prebound acceptable option. Publication
requires the accepted decision and evaluation to precede occurrence. Merely
completing a run does not prove its business criteria were satisfied. Each named
milestone can be admitted once. Evaluation quarantine and hidden decision/history
rows fail closed. Gatekeeper policy controls who may read/perform case actions;
being the business owner alone does not grant runtime authority.

Readers validate evidence, collaboration, decision and fulfillment through their
existing services. Related cases remain typed links rather than recursive state
expansion, so explicit bidirectional relations do not create traversal loops.
Read projections are not multi-system snapshots. Immutable candidate rows may
remain after unsuccessful publication and confer no accepted case activity.

Tests run on memory, SQLite and PostgreSQL and cover the four domain consumers,
file/work/interaction links, milestone gating, ownership transfer, related cases,
closure races, reopening, cross-case rejection and tenant/authorization isolation.
