# Assurance (experimental)

Findings describe identified conditions independently of EvaluationRun phase. A
Finding pins a terminal evaluation and exact SpecificationPin. Typed vulnerability,
manufacturing CAPA, access-review and model-assurance satellites supply domain detail.
Operational evaluation completion does not imply a positive business verdict.

Disposition is a unique append-only reasoned choice: Remediate, Accepted,
FalsePositive, Waived or Deferred. Competing decisions cannot overwrite history.
This profile fixes one disposition per finding. Reconsideration creates a new
Finding referencing its predecessor rather than mutating a deferred/closed finding.
The old finding remains historical and is not implicitly closed or superseded.

Remediation records intended corrective work under a Remediate disposition.
Domain-owned CorrectiveWork represents execution intent without importing Fulfillment.
It begins Planned and ends with one immutable Completed or Cancelled finish.
Completion requires a typed Reevaluation of that remediation/finding from a different
completed EvaluationRun. FindingClosure is separate, uniquely closes the finding,
and requires completed remediation for Remediate; Deferred cannot close directly.
Multiple corrective actions can exist; closure selects its verified action. This
profile does not claim all actions have completed simply because a finding closes.

FindingAttestation binds a standalone Attestation to a Finding and a completed
EvaluationRun with matching specification and sealed support. Issuer, subject,
proof and validity live in the shared Attestation substrate. Assurance adds no
independent assertion identity or revocation model. Historical validity remains readable.

`Assurance.current` rereads terminal facts and every support reference through
Engine policies, including the exact sealed membership and optional artifact.
Unreadable terminal evidence fails closed. `issue` validates support before create;
raw schemas enforce same-run/specification/support and remediation/finding links.
Explicit one-hop witness references avoid depending on recursive reference loading.
The tested imported EvaluationOutcome wire value `Completed` is used in rules;
changing that upstream wire contract requires compatibility review.

Generated consumer tests run the full loop on memory and SQLite, including typed
fixtures, all dispositions, invalid closures, terminal races, historical replacement,
artifact pinning, confidentiality and tenant denial. Local evidence is not hosted
D1/PostgreSQL/DynamoDB certification: F40-STORE remains planned.

## Version 0.2: shared Attestation

Assurance now references `attestation.Attestation` through `FindingAttestation`.
Create an authorized standalone assertion, then call `Assurance.issue` with
`finding`, `attestation`, `finish`, and `run` to attach its assurance profile.
The profile must pin the finding's specification and the completed evaluation's
sealed support. `current` and `end` accept the profile ID and delegate the
assertion lifecycle to the shared service. Creation is two explicit steps: an
unattached assertion is independently meaningful but conveys no finding closure.

This is a breaking 0.1 → 0.2 model migration. Keep old Attestation/AttestationEnd
rows as historical evidence; do not drop their tables automatically. Migrate
issuer identities to typed AttestationSubject links, copy each assertion with an
explicit subject and source citation, preserve old-to-new ID mappings, copy
terminal facts, then create FindingAttestation profiles. Old data lacks an
explicit subject: domain owners must supply that mapping rather than guess it.
New traffic must use the 0.2 contract. No automatic destructive backfill is run.
