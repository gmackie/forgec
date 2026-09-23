# Flight-control / autopilot supervisor

This is an illustrative research fixture, not a deployable controller. Its proposed requirements are examples for testing the semantic boundary; numbers are not derived from a certified design.

An operator approves a versioned envelope before engagement. AirframeIO releases a tick with a sequence-numbered sensor frame. ReactToFlightTick reads that envelope and its prior FlightMode, rejects stale or disagreeing channels, selects the permitted mode, and emits a SurfaceDemand plus a ControlDecision. A demand is a typed intent, not proof that a control surface moved.

A missing frame, invalid attitude, channel disagreement or late reaction prevents a new tracking demand. The illustrative response requests disengagement and records its cause; the actual aircraft-specific reversion and pilot annunciation rules require hazard analysis. Restart begins disengaged and does not silently restore an earlier tracking mode. Replica comparison/voting belongs to a separately verified realization of the same logical owner.

## Operations and ownership

`ApproveFlightEnvelope` is the sole logical producer of `FlightEnvelope`. `ReactToFlightTick` owns `FlightMode` and emits `ControlDecision`. `AirframeIO` supplies `FlightSample` and accepts `SurfaceDemand`. The previous-state input is optional only for explicit startup; normal reactions require a coherent prior sequence. Approval validation and operator authority are stated integration obligations, not implemented policies in this structural fixture. Request activation carries the proposed approval payload.

## Walkthrough and failure experiment

1. Approve revision R1 while stopped/disengaged/idle.
2. Release sequence 41 with a fresh sample, R1 and the prior mode; correlate the resulting command and audit by sequence.
3. Inject an invalid sample at sequence 42. The specialized logic must choose the documented inhibited behavior and explain it in the decision.
4. Delay sequence 43 beyond 5000 microseconds. Reject a late command and require independent monitoring; a later audit cannot retroactively satisfy the missed deadline.
5. Restart or deliver duplicate sequence 42. Do not infer exactly-once actuation from a fact ID; the I/O realization needs fencing/sequence validation and a defined startup state.

These are review scenarios, not executed control simulations. Durable audit recording may run asynchronously, but command/audit correlation and loss reporting need a bounded realization; blocking a hard deadline on a general-purpose database is not implied.
