# Change

Change fixes exact fromPin/toPin revisions, stream sequence, approval policy and
verification policy before execution. Gated changes pin a DecisionCase and approved
DecisionOption. Immutable decision links must select that case's finalized outcome;
Changes validates the real Decision state, including its rule result and snapshot.
A rejected option cannot authorize implementation. Ungated changes need no decision.

Impact evaluations pin the target definition. Implementation links pin typed
Fulfillment and scheduled time. Completed changes require fully completed fulfillment
and, when policy requires it, a completed evaluation with sealed evidence. Terminal
facts are unique per change. Terminal state takes precedence over late implementation
candidates, so a cancellation racing scheduling cannot reopen the change. External
workers must consult validated Change state and obey their own execution fencing;
an implementation link alone is not authority to execute after cancellation.

Rollback creates an explicit higher-sequence change with reversed immutable pins.
The original is RollbackPlanned until the reverse change completes; creating a
rollback request never claims physical recovery. Supersession points to a strictly
higher sequence in the same stream, preventing cycles without editing old history.
Failed, Cancelled and Rejected terminal outcomes are explicit. This package records
coordination facts and does not itself execute external deployments or recipes.

Synthetic software deployment, recipe and policy consumers exercise real lower
packages on memory, SQLite and local PostgreSQL. They cover concurrent approval and
implementation, rejection, required verification, ungated completion, immutable
history, retry, rollback, supersession and authorization. Hosted D1/DynamoDB remain
unverified; F41-STORE is planned.
