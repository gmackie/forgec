# Industrial packaging line / PLC coordination

This is an illustrative research fixture, not a deployable controller. Its proposed requirements are examples for testing the semantic boundary; numbers are not derived from a certified design.

ApproveRecipe installs a batch-specific revision while the line is stopped. LineIO supplies a sampled input image; ReactToScan evaluates guard and jam interlocks before sequencing conveyor and sealer requests. It owns LineMode and ScanDecision, exports one ActuatorIntent, and records the applied recipe revision. A recipe change becomes eligible only at a safe stopped boundary, not halfway through a scan.

Opening a guard or detecting a jam latches faulted and requests motion inhibition. Reset is a deliberate stopped-state operation with conditions rechecked; restoration of a sensor alone does not automatically resume motion. An emergency-stop circuit and safety PLC remain independent of this ordinary sequencing sketch. A stale image or missed scan creates an explicit fault rather than replaying an old seal pulse.

## Operations and ownership

`ApproveRecipe` is the sole logical producer of `ApprovedRecipe`. `ReactToScan` owns `LineMode` and emits `ScanDecision`. `LineIO` supplies `ScanImage` and accepts `ActuatorIntent`. The previous-state input is optional only for explicit startup; normal reactions require a coherent prior sequence. Approval validation and operator authority are stated integration obligations, not implemented policies in this structural fixture. Request activation carries the proposed approval payload.

## Walkthrough and failure experiment

1. Approve revision R1 while stopped/disengaged/idle.
2. Release sequence 41 with a fresh sample, R1 and the prior mode; correlate the resulting command and audit by sequence.
3. Inject an invalid sample at sequence 42. The specialized logic must choose the documented inhibited behavior and explain it in the decision.
4. Delay sequence 43 beyond 10000 microseconds. Reject a late command and require independent monitoring; a later audit cannot retroactively satisfy the missed deadline.
5. Restart or deliver duplicate sequence 42. Do not infer exactly-once actuation from a fact ID; the I/O realization needs fencing/sequence validation and a defined startup state.

These are review scenarios, not executed control simulations. Durable audit recording may run asynchronously, but command/audit correlation and loss reporting need a bounded realization; blocking a hard deadline on a general-purpose database is not implied.
