# Qualification (experimental)

Qualification defines durable business ability facts, not Forge authorization
capabilities. Definition identity includes a SpecificationPin; authored definitions
must resolve mutable selectors before registration. Revisions create new definition
records. QualificationLevel codes and integer ranks belong to one exact definition:
there is no universal skill rank or implicit cross-version comparison. Codes and
ranks are unique within that definition and cannot be edited. A rank establishes
order, not a measurable quantity. Domain owners control vocabulary registration.

QualificationSubject is specific to this graph. PartySubject maps a business Party
to a subject. Technician and Vendor fixtures use that typed mapping; Runner references
a subject directly, without pretending every machine is a Party. Domain detail and
credential/attestation producer relationships are typed satellites pointing to the
award. Qualification never imports Evaluation, Assurance or Routing.

Awards pin subject, definition, optional level, Party issuer, issuer-record identity,
issuedAt/expiresAt and optional EvidenceSeal. The exact sealed support is retained;
additional candidate evidence cannot change it. Issuer/record uniqueness prevents
duplicate issuance. A unique append-only QualificationRevocation closes validity
at effectiveAt; earlier history remains queryable. A replacement or renewal is a
new award with a new issuer-record identity. Raw schema writes enforce reference
and same-definition level constraints, as well as valid time windows.

`Qualifications.satisfies(subject, requirement, at)` checks the half-open validity
window, revocation, exact definition and any domain minimum level. It consumes
storage cursors (at most three pages and 128 visible candidates), fails explicitly
when the budget is exceeded, and rereads terminal facts, issuer and evidence through
normal authorization. Callers must not cache a positive answer across validity or
revocation changes. This query does not reserve capacity, authorize access, or fence
an eventual routing decision against a later revocation; Routing must revalidate
its selected snapshots when accepting an assignment.

Local generated memory/SQLite tests cover technician, vendor and Runner subjects;
level and definition mismatch; immutable awards; duplicate issuance and revocation
races; expiry/history; a later page of eligible credentials; sealed support;
unreadable terminal facts/support; and tenant/policy isolation. Actual Routing
integration (F56-05) remains planned, as do Assurance/Evaluation producer adapters.
This package exposes typed hooks for those adapters without asserting they exist.
Hosted D1/PostgreSQL/DynamoDB certification is not claimed.
