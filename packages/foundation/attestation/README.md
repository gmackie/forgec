# Standalone Attestation

An issuer makes an assertion about an identified subject under an exact SpecificationPin, independently of Evaluation, Finding or remediation. AttestationSubject is bound through typed Party, ArtifactRevision, QualificationSubject or domain-owned attachment resources; it is not a universal targetType/targetId reference. IssuerRecord is unique within the issuer. Citations, sealed Evidence and optional exact proof artifacts preserve provenance.

Attestations.issue validates authorized subject, specification, evidence and artifact reads. current uses half-open validity, and fails closed on hidden revocations or support. A single immutable AttestationEnd revokes or supersedes an assertion; replacements preserve issuer, subject and assertion specification with later validity. QualificationAttestation binds the exact holder, issuer, definition and validity; Attestations.qualification evaluates both lifecycles. Consumers must use that projection for attestation-backed qualifications, not infer continued support from a historical link.

Assurance 0.2 consumes this substrate through FindingAttestation. It owns finding/evaluation binding only; validity, issuer identity and termination are shared. No second assertion envelope remains in Assurance.

Cryptographic proofs and external VC serialization are optional domain/L1 profiles. The software fixture attaches a proof artifact; core tests verify its exact revision and authorization, not cryptographic authenticity. A provider must verify the selected proof format before treating it as cryptographic assurance. Issuer authority is decided by Qualification, Delegation and policy, never inferred from being able to create a Subject.

Memory/SQLite/PostgreSQL tests cover independent assertions, typed consumers, Qualification integration, tenant separation, hidden history and terminal races. Restrict untrusted raw writes that bypass service evidence/authorization checks. Optional serialization does not alter assertion identity or lifecycle.
