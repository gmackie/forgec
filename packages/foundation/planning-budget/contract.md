# planning-budget contract

Issue #67; implementation acceptance remains planned.

## Ownership

Goals/targets, milestones, immutable forecast scenarios, funding constraints, encumbrance and actuals links.

## Composition

Required dependencies: specification, allocation, evaluation, ledger, classification, usage, fulfillment.

Usage and Fulfillment are included to verify the actuals/execution portion of #67. Risk budgets and Service-level milestones use upper joins; Plan is not a workflow.

## Independent acceptance

Project/procurement/capacity; forecast distinct from actual; no overspend under competing encumbrance; actual Usage/Ledger links; reversal/release history.

- F67-01: goal/target model
- F67-02: plan + milestone model
- F67-03: forecast/scenario representation
- F67-04: budget/funding envelope
- F67-05: allocation/ledger actuals integration
- F67-06: fixtures for project plan, procurement budget and capacity plan

Compile typed consumer fixtures, execute generated-bundle behaviors and adversarial cases, and bind evidence to accepted dependency revisions. Provider certification is separate from local tests.
