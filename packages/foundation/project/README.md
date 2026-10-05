# Project and Program

Program groups initiatives under a sponsor/scope. Project binds sponsor, owner,
participants, pinned scope, Planning plan/goal, optional forecast and funding
envelope. Fixed work/dependency counts define a complete bounded execution graph.
Software, capital/construction and research consumers provide local vocabulary.

WorkPackage is business scope decomposition, not a runtime Task. Parent/depth
links form the WBS, while ProjectDependency separately models finish-to-start,
start-to-start and finish-to-finish constraints. `Projects.progress` checks complete
membership and rejects cyclic dependency graphs. Up to 16 work packages and 32
dependencies are supported. Parent summaries are excluded from leaf totals.

Every work package links a Fulfillment, optional Usage stream, milestone, Allocation
reservation and Scheduling appointment. Progress comes from durable Fulfillment
start/end facts; only complete coverage counts as completed. Usage actuals include
an explicit contributing event manifest and exact actual-minus-planned quantity
per package, with matching units. Missing Usage is unknown, not fabricated zero
completion. Different quantities/units are not summed into an invented percent.

Progress returns planned-due/completed leaf counts, overdue work, separate planned
dependency satisfaction, actual readiness and observed sequencing violations.
It does not stop or schedule execution automatically. Fulfillment/Usage are
projected through the supplied cutoff; the budget, allocation and appointment
views are current state, not a claim of a historical multi-system snapshot.

Budget state delegates to Planning/Budget, including its verification of published
Ledger postings. Forecast assumptions remain separate from actual spending.
ProjectMilestoneResult links a completed, unquarantined Evaluation; completion of
the evaluation is not automatically a successful business milestone verdict.

Immutable project definitions are execution baselines. Revised plans/projects can
be related by application profiles; this package does not silently mutate the WBS
or infer a prescribed workflow. Partial or unreadable membership fails closed.
Local memory, SQLite and PostgreSQL tests cover actual work/usage/spend, scheduling,
allocation, complete graphs, typed consumers, dependency cycles and isolation.
