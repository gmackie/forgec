# Collections / Dunning

Collection links a SettlementPosition to a Case and pinned aging policy. It must
be overdue at opening, using the knowledge available when the collection was
recorded. `Collections.state` derives the outstanding amount and whole UTC days
past due from Settlement at an explicit query instant. Warning/escalation stages
use policy thresholds. No balance is copied from Billing, and a promise or notice
never changes the economic position. A fully reversed materialization is void,
not a successful collection.

`notice` validates the debtor's Notification recipient and an optional admitted
Case interaction. It reports Notification delivery state without sending anything.
`promise` validates a new issued Agreement/arrangement for the same counterparties,
accepted decision, units/amount, deadline and optional satisfied Challenge with a
typed debtor identity mapping. One promise is modeled per collection in this
profile. Payment progress is net Settlement since the promise's recorded baseline;
reversals can make a kept promise broken again. This is an explanatory projection,
not a second allocation of payments or a legal interpretation of agreement text.

`dispute` binds a reviewed charge to an issued Bill's exact Settlement position and
the debtor appellant. Other non-billing disputes remain domain extensions. The
Dispute system preserves the original charge and its independent appeal lifecycle.

`closure` requires an admitted Case close. Cure requires a positive materialized
position with zero remaining balance at closure knowledge time. Later reversal or
Case reopening makes it ineffective without deleting history. Writeoff and external
recovery use an accepted evaluation, evidence, a published unreversed Ledger group
or completed handoff Fulfillment, and a mandatory profile admission callback that
validates financial/recovery scope. Without that callback those effects fail closed.
They do not silently settle debt or create accounting entries. Hosts own collection
communications, recovery execution and applicable domain policy.

The package uses `collections-dunning` to avoid the existing language collections
fixture name. Co-deploying Challenge and Dispute also exposed a SQL name collision:
Trust's PartySubject mapping is now TrustPartySubject, distinct from Qualification's
PartySubject. Trust/Challenge consumers and snapshots are refreshed; consumers of
the old 0.1 Trust symbol must update to the new name.

B2B invoice, SaaS subscription and consumer account profiles share the system.
Memory/SQLite/PostgreSQL tests cover aging, notices, promise progress, partial
payment, premature cure rejection, settled closure, reversed payment, reopening,
external recovery admission and tenant/source isolation.
