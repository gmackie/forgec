# Concept boundary: flight-control

The supervisor is **B overall**, with **A** islands for discrete approvals and audit and **C** handoffs for control and verification semantics. A Process remains useful as the owner of one reaction's intent. It does not become a flight-control calculus because its activation is named Tick.

| Concern | Layer / outcome | Decision |
|---|---|---|
| coordination | L0 / A | ApproveFlightEnvelope owns FlightEnvelope; ReactToFlightTick owns FlightMode and ControlDecision. Typed I/O separates an observation from a commanded intent. |
| reaction-budget | L0 facet / B | Illustrative 10,000 us period, 5,000 us release-to-command deadline, 2,000 us WCET budget. A 100 ms sampling change changes intended behavior. |
| safe-modes | L0 facet / B | Startup/disengagement and explicit recovery are domain obligations. `mode: text` only stores vocabulary; this fixture has no executable transition proof. |
| execution-strategy | L1 / B | Synchronous evaluation, buffering and deterministic channel voting require an explicit realization with pinned assumptions. |
| deployment | L2 / B | RTOS task priority, processor/bus mapping and physical redundant channels are separate from semantic ownership. |
| specialized-semantics | external / C | Fusion/control equations, stability, actuator response and formal failure analysis stay in specialized models. |

## Why arrows are insufficient

The feedback edge FlightMode -> ReactToFlightTick refers to the prior logical state. It does not assert a zero-delay algebraic loop, synchronous language `pre` semantics or a solver step. A sequence identifier and an illustrative mode list do not establish sensor coherence, monotonic execution, mutual exclusion or deterministic floating-point evaluation. Those are obligations of the selected control model and realization. Redundant hardware channels can all implement ReactToFlightTick without becoming independent semantic owners; the voter, fencing and common-cause assumptions must explain which command becomes authoritative.

The timing sidecar fixes a requirement, not a timer: release-to-command acceptance includes I/O and bus delay. An offline inequality check cannot account for interrupts, preemption, cache state, release jitter or network contention. No runtime monitor, WCET analyzer, schedulability tool or flight dynamics simulation is run by this fixture.

## Comparison with established models

[AADL at SEI](https://www.sei.cmu.edu/projects/architecture-analysis-and-design-language-aadl/) models architectural categories such as processors, devices and threads and supports embedded-system analysis. That is where the deployment sketch belongs: a ConceptIR Process says who owns a reaction; an AADL realization can supply platform bindings and analysis assumptions. A processor name is not imported into L0 simply to make the graph look embedded.

[AUTOSAR Classic](https://www.autosar.org/standards/classic-platform) separates application software, RTE and basic software. The useful analogy is stable logical interfaces versus hardware-dependent execution, not that an autopilot should adopt an automotive platform or that AUTOSAR supplies an avionics safety argument.

[SCADE Suite](https://ansys.synopsys.com/products/embedded-software/ansys-scade-suite) offers dedicated model analysis and architecture/design synchronization. A production synchronous control model and its tool-qualified generation evidence would be external artifacts tied to ReactToFlightTick's exact ports. The supplied pseudocode is neither SCADE syntax nor generated code. [Simulink sample-time documentation](https://www.mathworks.com/help/simulink/ug/types-of-sample-time.html) is relevant to sampled/continuous distinctions, but its page returned 403 in this research run: no solver behavior is inferred from that inaccessible page.

[SysML v2](https://www.omg.org/spec/SysML/2.0/About-SysML) explicitly covers system structure/behavior and analysis/verification cases. A requirement-to-test relationship is useful shared metadata; the truth of a stability or safety claim remains in the linked evidence and assumptions, not in a generic reference edge.

## Promotion decision

Promote a proposed timing contract family only after flight-control, packaging-line and medical-device agree on clock origin, deadline endpoint and failure interpretation. All three show the same orthogonal requirement pressure while retaining different execution engines. Modes similarly begin as vocabulary plus transition/recovery contracts, then a package pattern; they do not justify a new kernel node. Sensor fusion and stability fail that reuse test and remain external. No new primitive is proposed.
