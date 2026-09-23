# Risk

Risk is a future-harm scenario, not an Assurance finding. A domain owns immutable
RiskScale/Level vocabularies and any method-specific scoring satellites. Likelihood
and impact remain separate dimensions; no universal risk score is calculated.

Assessment revisions retain exact completed EvaluationFinish and EvidenceSeal pins.
A unique risk/revision serializes competing revisions. A treatment points to a
FulfillmentSet; work completion does not prove mitigation success. ResidualRisk
explicitly joins the baseline treatment to a later assessment of the same risk.

RiskAcceptance is a candidate provenance link. Consumers must call acceptance()
with their designated domain acceptance option; it verifies the authoritative
Decision journal outcome rather than trusting a raw outcome candidate. Acceptance
never grants authorization. Normal engine policies govern every command and read.

Generated project/security/vendor fixtures and tests cover memory, SQLite and local
PostgreSQL when configured. Hosted D1/DynamoDB certification is separate. Domain
controllers own monitoring frequency and whether residual risk requires a new
acceptance decision; no workflow completion silently rewrites a prior assessment.
