# Challenge / Friction

ChallengeDecision records an exact policy evaluation, evidence, optional contextual Risk and
Trust inputs, and an allow/require/deny/defer disposition. A required Challenge pins a
verification specification, mechanism, retry bound and deadline within a typed interaction.
Customer-service and agent-action consumers keep their domain payloads. The authored
Interaction/Subject/Relationship contract is checked against compiled entities in CLI tests.

Challenges owns a bounded append-only event chain: failed attempts may retry, while satisfied,
cancelled and explicitly expired events are terminal. Unique ordinals serialize competing
attempts and cancellation. Unpublished attempt rows are inert. The interpreter checks every
record and authorized evidence read, rejects hidden history, and derives expiration even
before an explicit expiry event is written. Satisfaction expires at the same deadline.

Domain applications supply a ChallengeVerifier that interprets pinned evaluation results.
It must bind evidence to the exact challenge, subject/action context and mechanism. The
proof fixture uses a typed immutable VerificationObservation; there is no built-in biometric,
CAPTCHA, authentication vendor or arbitrary success flag in the service API. Quarantined
Evaluation results fail closed. Manual review uses ChallengeApproval bound to an exact option
before voting; only the finalized Decision outcome can satisfy that requirement.

`assurance` returns a short-lived Gatekeeper PIP value named for the challenge, plus subject,
interaction and requirement provenance. The caller supplies its trusted principal-to-subject
mapping. Policy must select the appropriate challenge for the requested action; the returned
fact alone never grants permission. Use live attribute resolution or invalidate policy caches
when assurance inputs change. Tests demonstrate separate allow/deny policy evaluation from
the resulting Boolean fact. Gatekeeper owns no challenge transitions.

Current and historical policy evidence can become unreadable or quarantined; consumption
then fails closed. A new policy decision/challenge represents reconsideration, preserving the
old history. Raw candidates and authored ConceptIR contracts are not implementation proof.

Validated on memory, SQLite and PostgreSQL: risk/trust inputs, proof and step-up forms,
failed retries, exhausted attempts, racing cancellation, expiry, prebound manual approval,
subject mismatch, hidden history and tenant isolation.
