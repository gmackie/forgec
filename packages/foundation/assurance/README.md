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

Attestation pins Finding, issuer, issuer-record identity, exact specification,
completed evaluation, its EvidenceSeal, optional ArtifactRevision, qualified
conclusion and half-open validity. AssuranceIssuer is a system-specific handle;
domain issuer identity mappings remain typed satellites. No authorization grant or
universal actor reference is introduced. Unique AttestationEnd records revocation
or a later same-finding/same-issuer replacement. Historical validity remains readable.

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
