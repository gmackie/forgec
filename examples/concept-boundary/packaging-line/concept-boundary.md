# Concept boundary: packaging-line

Sequencing coordination is **B overall**: **A** covers recipes, batches and decision records; **B** covers scan/mode requirements; **C** covers PLC execution semantics and physical safety analysis. Calling a function block a Process preserves responsibility but does not preserve its execution law automatically.

| Concern | Layer / outcome | Decision |
|---|---|---|
| coordination | L0 / A | ApproveRecipe owns ApprovedRecipe; ReactToScan owns LineMode and ScanDecision, with typed ScanImage and ActuatorIntent at LineIO. |
| reaction-budget | L0 facet / B | Illustrative 20,000 us period, 10,000 us release-to-output-acceptance deadline, 4,000 us WCET budget. |
| safe-modes | L0 facet / B | Fault latching, no automatic restart and recipe-change boundaries are meaningful requirements. |
| execution-strategy | L1 / B | Cyclic scan versus event-triggered function-block realization must be selected and specified explicitly. |
| deployment | L2 / B | PLC tasks, remote I/O latency and safety-controller separation are placement concerns with analysis obligations. |
| specialized-semantics | external / C | Input/output-image rules, execution-control charts and stopping-distance dynamics are not supplied by Process edges. |

## Scan versus event

For the cyclic sketch, all interlock decisions should use a defined input image and produce one latched output image. An event-delivery Process network may instead observe a later guard state between two actions. Those graphs can have identical components and different admissible behavior. The External Tick event is only an interface to the scan release; it neither introduces periodic scheduling nor establishes atomic input sampling.

An interlock such as guard-open implies motion-inhibit can be written as a desired contract. It is not yet proved by a text mode field, and it does not prove stopping distance or independent emergency-stop operation. The proposed mode facet states startup and reset obligations only. The safety circuit remains a separately assessed implementation rather than a second owner of LineMode; its physical override and feedback must be explicitly integrated in a real design.

## Official comparisons

[IEC 61131-3:2013](https://webstore.iec.ch/en/publication/4552) specifies syntax and semantics of PLC programming languages, including Structured Text and Function Block Diagram. The accessible catalogue abstract establishes scope; the purchased normative text was not reviewed, and this older edition is identified deliberately. The `.st-sketch.txt` artifact uses illustrative notation, not a conforming or compiled PLC program. Scan/task semantics must be checked against the actual standard edition and controller implementation.

[IEC 61499-1:2012](https://webstore.iec.ch/en/publication/5506) describes a generic architecture and implementable reference models for distributed industrial function blocks. This supplies a comparison point for distribution, not evidence that arbitrary event-triggered Process composition implements IEC 61499. Event/data association, execution-control charts and runtime scheduling need specialized modeling and version-specific validation; the catalogue abstract alone is not sufficient to establish them.

[AADL](https://www.sei.cmu.edu/projects/architecture-analysis-and-design-language-aadl/) contributes the distinction between software responsibility and processor/device/thread architecture. [AUTOSAR Classic](https://www.autosar.org/standards/classic-platform) similarly separates application, RTE and basic software, useful for reasoning about a stable logical I/O interface without claiming that a PLC is an AUTOSAR system. [Stateflow](https://www.mathworks.com/help/stateflow/ug/overview-of-stateflow.html) is another state-machine modeling option; its documentation retrieval returned 403, so transition-priority details are explicitly left unresolved.

## Promotion decision

The timing budget shape is shared with flight-control and medical-device, but cyclic input-image semantics are not universally shared. Start with the same proposed timing facet and a PLC realization pattern. Only repeated evidence that multiple unrelated domains require the same execution laws could justify a named execution profile. Do not create a ScanProcess kernel kind or silently equate scan, synchronous and discrete-event semantics. Modes can share a contract pattern for latching and explicit recovery while preserving domain-specific safe outputs.

The offline corpus validates positive microsecond budgets and `WCET <= deadline <= period`. It does not prove task response time, bus latency, interlock implementation, timer precision or runtime safety. A real deployment needs those analyses plus equipment hazard assessment and hardware testing.
