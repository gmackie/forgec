# Intake

IntakeForm pins the exact SpecificationPin. Submission copies that pin under a
schema rule and optionally retains an immutable ArtifactRevision. A Party is the
submitter identity; membership is not required. Anonymous submissions are legal
only for explicitly anonymous-enabled forms. Form+sourceKey is unique and standard
Engine idempotency keys replay exact submissions; conflicting bodies fail.

SubmissionValidation links a completed EvaluationRun at the same form definition.
Its verdict remains a separate business fact from operational completion. Failed
or cancelled evaluation cannot validate a submission. Rejected validation cannot
create the example domain outputs, including through raw generated CRUD.

The domain owns the transformation code and output resource. Expense, vendor and
clinical questionnaire fixtures define typed fields and a unique validation link,
so retries cannot duplicate an output within a domain type. This is not a universal
JSON form payload or universal Result schema. A validation may intentionally have
multiple different typed output satellites; the package does not claim one global
cross-domain output. Raw artifacts and submissions remain immutable when definitions
advance. Consent and evidence can attach through explicit domain-owned satellites.

The tests execute the generated consumers on memory and SQLite. Transformation
execution is application-owned: the package supplies typed reference/validation
contracts, not automatic extraction of arbitrary uploaded bytes. Hosted-provider
certification is not implied.
