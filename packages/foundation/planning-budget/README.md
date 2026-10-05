# Planning and budget

Plans pin specifications, goals declare exact-unit targets, milestones reference Fulfillment sets and Evaluation results, and immutable forecast scenarios retain assumptions separately from actuals. Funding envelopes use a Ledger account and exact six-decimal limit.

Budgets.publish commits one guarded budget journal event and optional Allocation transition in one authorized atomic group. Competing encumbrances cannot exceed the envelope even if capacity remains available. Spending requires an exact published Ledger group debit to the envelope account and cannot exceed the committed amount; optional Usage and Fulfillment references retain source provenance. Spending releases the full resource reservation and unused budget amount. Reversal requires the exact Ledger inverse and restores funding; releases and reversals retain history. Use Budgets.state for a complete validated journal, never candidate rows as authority.

This is a bounded experimental profile:128 events per envelope, positive expense/debit convention, one actual per encumbrance, no partial resource release, no currency conversion, and no transactional coupling to external payment execution. Ledger postings are durable before budget publication; failures leave a staged actual for reconciliation, not an asserted budget spend. Restrict raw journal writes to trusted publishers. Synthetic project/procurement/capacity probes pass on memory, SQLite and PostgreSQL. Hosted D1/DynamoDB certification remains pending.

Journal reads also require the matching validated Allocation command for each
capacity-backed budget event. A raw budget event cannot claim capacity authority
without it. Logical retries are identified by predecessor plus exact command inputs
and return the published event, even after later events advanced the head. Exact
six-decimal regression traces cover 0.1 + 0.2 + 0.000001 and one-micro-unit overflow.
