# Incident and Problem Management

Incident records an undesirable occurrence and evidence inside a Case. Optional
Risk and Finding links remain distinct facts; neither is inferred from the incident.
Problem records a root-cause hypothesis with its own investigation Case, evidence,
pinned diagnosis and accepted decision option. IncidentCorrelation groups any
number of incident occurrences around a candidate problem without declaring the
hypothesis proven.

`Incidents.known` validates a completed, unquarantined diagnosis, accepted decision,
sealed evidence and pinned workaround. Remediation links separate Fulfillment,
optional Change, verification run and acceptance criteria. `verification` requires
complete execution and accepted verification; a completed Change must refer to the
same remediation fulfillment.

IncidentResolution ties a correlation and verification to an admitted Case closure.
`resolution` reports whether that closure is still current. Reopening through Cases
preserves the resolution record but makes `current` false; another closure can
carry another resolution. Case lifecycle and responsibility remain owned by Case
Management, with no parallel mutable incident status.

`incident` composes the linked ServiceLevel state at an explicit query instant.
`correlation`, `known`, `verification` and `resolution` authorize and validate all
supporting records before use. Raw candidates do not prove diagnosis or recovery.
No remediation, notification or risk-acceptance workflow runs implicitly.

Service/IT, security, manufacturing-quality and customer problem consumers share
the system. Local memory/SQLite/PostgreSQL tests cover repeated incidents, diagnosis
acceptance, incomplete remediation rejection, verified closure, reopening, SLA
warning state and tenant isolation.
