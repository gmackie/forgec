# Embedded infusion-device supervisory boundary

This is an illustrative research fixture, not a deployable controller. Its proposed requirements are examples for testing the semantic boundary; numbers are not derived from a certified design.

A separately authorized clinical workflow supplies an approved prescription and limit profile; ApproveTherapy records their revision identity. PumpIO provides sensor observations. ReactToTherapyTick reads the approved therapy and prior TherapyMode, checks inhibition conditions, emits PumpIntent and records a TherapyDecision tied to the selected revision. No dosage calculation, clinical recommendation or actual pump control is implemented.

An occlusion indication, open door, unhealthy watchdog or stale sample inhibits delivery intent and requires alarm handling. Clearing an indication does not automatically restart delivery: acknowledgement and a new permitted transition are required. The correct clinical safe state depends on therapy and hazard analysis; stopping is an illustrative requirement, not a universal medical safety claim. A missed tick must be detected by an independent watchdog, since the failed process cannot reliably audit its own absence.

## Operations and ownership

`ApproveTherapy` is the sole logical producer of `ApprovedTherapy`. `ReactToTherapyTick` owns `TherapyMode` and emits `TherapyDecision`. `PumpIO` supplies `PumpSample` and accepts `PumpIntent`. The previous-state input is optional only for explicit startup; normal reactions require a coherent prior sequence. Approval validation and operator authority are stated integration obligations, not implemented policies in this structural fixture. Request activation carries the proposed approval payload.

## Walkthrough and failure experiment

1. Approve revision R1 while stopped/disengaged/idle.
2. Release sequence 41 with a fresh sample, R1 and the prior mode; correlate the resulting command and audit by sequence.
3. Inject an invalid sample at sequence 42. The specialized logic must choose the documented inhibited behavior and explain it in the decision.
4. Delay sequence 43 beyond 2000 microseconds. Reject a late command and require independent monitoring; a later audit cannot retroactively satisfy the missed deadline.
5. Restart or deliver duplicate sequence 42. Do not infer exactly-once actuation from a fact ID; the I/O realization needs fencing/sequence validation and a defined startup state.

These are review scenarios, not executed control simulations. Durable audit recording may run asynchronously, but command/audit correlation and loss reporting need a bounded realization; blocking a hard deadline on a general-purpose database is not implied.
