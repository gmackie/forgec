# Where ConceptIR stops

This is the embedded/cyber-physical **boundary corpus** for [#88](https://github.com/gmackie/forgec/issues/88). It complements the [business validation corpus](../concept/README.md), rather than expanding that corpus's ontology.

Read the [semantic pressure matrix](pressure-matrix.md) and [boundary synthesis](../../docs/conceptir-boundary-corpus.md), then a fixture's `domain.md` and `concept-boundary.md`. Classification is per concern: **A** native discrete coordination, **B** reusable facet/pattern pressure, **C** a different semantic domain. A fixture need not have a single overall label.

| Fixture | Boundary being tested |
| --- | --- |
| [Flight control](flight-control/domain.md) | Periodic reactions and mode/safety obligations versus control-law and deployment analysis |
| [Packaging line](packaging-line/domain.md) | Recipes/interlocks and cyclic coordination versus PLC execution semantics |
| [Robot mission](robot-mission/domain.md) | Mission goals and replanning versus continuous trajectory/control |
| [Network control](network-control/domain.md) | Desired/observed ownership and reconciliation versus convergence proofs |
| [Game simulation](game-simulation/domain.md) | One authoritative world and input ordering versus deterministic numerical execution |
| [Consensus](consensus/domain.md) | Architecture/administrative intent versus adversarial protocol safety/liveness |
| [Medical device](medical-device/domain.md) | Discrete supervision/audit versus hard timing, control and safety evidence |
| [Digital twin](digital-twin/domain.md) | Scenario/artifact/result orchestration versus acausal dynamics and co-simulation |
| [Hardware dataflow](hardware-dataflow/domain.md) | Typed configuration/results versus clocks, rates, buffers and synchronous laws |
| [Scientific workflow](scientific-workflow/domain.md) | Experiment/provenance orchestration and reproducibility versus numerical executor implementation |

Each fixture contains typed `concept-ir.json` for the current kernel, `boundary.json` for research concerns/proposed facets, diagram sources in `views/`, questions, and specialized artifact/interface sketches. Proposed facets are deliberately outside the compiler schema. They are **not implemented runtime guarantees**.

## Verification

```sh
cargo test -p forgegraph-semantic --test concept_boundary --locked
```

The default run requires all ten fixtures, all 22 pressure categories, three unrelated timing examples, closed type/port references and digest-pinned specialized artifact handoffs. Timing checks exercise finite synthetic observations; they do not prove worst-case behavior or physical safety. Specialized-model READMEs disclose exactly which tools ran, what bounded assertions were checked, and which files remain sketches.

Generated `views/concept.json`, `views/handoffs.json` and `coverage.json` are reproducible:

```sh
UPDATE_BOUNDARY_CORPUS=1 cargo test -p forgegraph-semantic --test concept_boundary --locked
cargo test -p forgegraph-semantic --test concept_boundary --locked
```

Use `BOUNDARY_FIXTURE=<slug>` only while authoring; it is not full-corpus acceptance. Review changes before regenerating snapshots so changed meaning or artifact bytes cannot be mistaken for already verified evidence. [AUTHORING.md](AUTHORING.md) records the shared format.

## Prior-art comparisons

These are boundaries to integrate with, not languages to reproduce in Forge. Fixture source entries link the specific official references supporting their comparisons.

| Established system | What it contributes | Forge boundary |
| --- | --- | --- |
| [SysML v2](https://www.omg.org/spec/SysML/2.0/) | Systems structure/behavior, requirements, analysis and verification relationships | Reference requirements/models/results; avoid absorbing systems-engineering decomposition |
| [AADL](https://www.sei.cmu.edu/projects/architecture-analysis-and-design-language-aadl/) | Component/platform architecture and analyses of embedded deployment properties | L1/L2 mapping and timing/resource evidence; ConceptIR alone does not prove schedulability |
| [AUTOSAR](https://www.autosar.org/standards/classic-platform) | Software component interfaces and separation from ECU/platform mapping | Keep logical ports distinct from tasks, runtime environment and ECU/network allocation |
| [IEC 61131-3](https://webstore.iec.ch/en/publication/4552) | PLC programming language and execution conventions | Represent intent/interlocks; leave actual PLC task/scan/program semantics with the implementation |
| [IEC 61499](https://webstore.iec.ch/en/publication/5506) | Distributed function-block systems with event/data interface semantics | A block diagram's execution rules are not implied by arbitrary ConceptIR Process edges |
| [Simulink / Stateflow](https://www.mathworks.com/products/stateflow.html) and [SCADE](https://ansys.synopsys.com/products/embedded-software/ansys-scade-suite) | Control/reactive and state-machine modeling with specialized simulation/analysis workflows | Pin control model/requirements and consume evidence; do not call a typed port graph a control proof |
| [Ptolemy II](https://ptolemy.berkeley.edu/ptolemyII/) | Explicit models of computation and heterogeneous composition | A common component graph does not establish common communication/execution laws |
| [Modelica](https://modelica.org/language/) | Acausal equation-based physical modeling | Equations and solver semantics stay external to discrete orchestration |
| [FMI](https://fmi-standard.org/) / [SSP](https://ssp-standard.org/) | Dynamic-model interfaces and system structure/parameterization interchange | Pin FMU/SSP/model artifacts and scenario/result contracts; interchange does not guarantee numerical validity |
| [TLA+ / PlusCal](https://lamport.azurewebsites.net/tla/tla.html) | State/action/temporal models and formal checking | Explicit protocol handoff; bounded safety checks do not prove unbounded liveness or implementation refinement |
| [Capella / Arcadia](https://www.eclipse.org/capella/arcadia.html) | Separation of operational needs, logical architecture and physical architecture | Preserve logical-to-placement mapping and traceability without importing all engineering views into L0 |

## Conclusion

The corpus proposes **no new kernel node kind**. Repeated timing, modes, replay and resource/safety obligations support investigating orthogonal facets and domain patterns. Continuous physics, formal protocol correctness and hardware/dataflow execution laws retain specialized models with typed, versioned evidence handoffs. See the synthesis for all ten open questions and the explicit exclusions.
