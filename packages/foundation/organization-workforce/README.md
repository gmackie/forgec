# Organization and workforce

Immutable OrganizationUnit parent/depth facts form an acyclic same-organization hierarchy. PositionSpecification pins the role definition and optional qualification requirement; Position owns a ParticipationSet and remains independent of its Incumbency candidates. Unit place and classification references preserve typed provenance.

Workforces.publish serializes exclusive position appointments and terminations with a unique position/ordinal journal. Workforces.state validates the complete bounded journal, and Workforces.at rechecks Participation and Qualification eligibility at the requested instant. Termination preserves prior occupancy. Concurrent revocation cannot be made serializable with appointments by this package; consumers must use at(), which fails closed when eligibility changes. Candidate/journal CRUD is not an authorization interface: trusted publishers and validated consumers are required. Appointments must be effective at their publication instant; future scheduling belongs above this package. No payroll or compensation model is introduced.

The current policy is one occupant per position, with half-open intervals and at most128 journal facts. Immutable unit reorganization creates new units/positions rather than rewriting past hierarchy. Tests use employee, production crew and incident-command synthetic consumers on memory, SQLite and PostgreSQL. Hosted provider certification remains separate.

An Appoint event must use the incumbency's exact start instant, preventing a later
appointment event from retroactively reporting occupancy before publication. A
repeated predecessor/incumbency/action/instant command returns the immutable event;
current eligibility remains separately enforced by at().
