# Access Governance

AccessIdentity explicitly binds a durable DelegationSubject to qualification and attestation
subjects. Workforce/tenant users may have Party profiles; delegated service accounts retain
their own software identity. AccessRequest records root entitlement, optional delegation,
membership and qualification prerequisites, exact policy, expiry, review deadline and evidence.
Its approval option must be bound before Decision responses. AccessGrant is effective only
with that finalized approval and effective underlying authority; it is not a new entitlement.

AccessReview assigns a Participation reviewer and typed certifier before voting. Periodic and
ad-hoc reviews declare a complete, bounded set of segregation-of-duties findings. Continuing
with known conflicts requires an explicit accepted-risk flag in addition to the approved
Decision. Each completion binds the finalized outcome to an Attestation by the assigned
reviewer for the exact subject/policy. Revoke and modify atomically publish a terminal grant
fact; modify requires a separately approved effective replacement. Continued reviews cannot
race past an administrative revocation. Unique journal ordinals arbitrate competing reviews.

`explain` reports root authority, delegation chain, source request, approval, review history,
next deadline and denial reasons. Expired grants, overdue reviews, inactive membership,
missing/revoked qualification, withdrawn certification, root/ancestor revocation and unreadable
terminal history fail closed. A renewed entitlement or modified scope needs a new approved
request/grant; scheduled renewal grants remain ineffective until their new validity starts. An old review cannot extend its root validity. Grant revocation does not rewrite
a shared root entitlement or another independently approved grant.

`pip` produces a one-second fact for a particular grant and trusted principal-to-subject
mapping. The consuming Gatekeeper policy still checks scope/right/purpose and any quantity or
constraint semantics; it does not own review or revocation transitions. Use live attribute
resolution or invalidate cached authorization when governance inputs change. Tests evaluate
an independent allow policy from this PIP and verify revocation changes the fact to false.

Tests cover workforce/admin, tenant and delegated service accounts; prebound approval;
periodic/ad-hoc reviews; recorded conflicts; continue/modify/revoke; racing revocations;
certification withdrawal; qualification and delegation revocation; hidden history and tenant
isolation on memory, SQLite and PostgreSQL.
