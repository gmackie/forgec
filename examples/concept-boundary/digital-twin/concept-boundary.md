# Boundary: orchestration A, repeatability B, physics C

| Concern | Layer / outcome | Boundary decision |
|---|---|---|
| simulation-orchestration | L0 / A | Scenarios, calibration identities, requests, status and result provenance are discrete information with one owner. |
| physical-dynamics | external / C | Differential/algebraic equations, units, initialization and continuous solution have different composition laws. |
| repeatability | L0 facet / B | Pinned dependencies plus numerical comparison policy could be a reusable contract; proposed only. |
| co-simulation-master | L1 / C | Solver choice, communication steps, event handling and rollback belong to numerical realization. |
| simulation-placement | L2 / A | Worker and artifact-store deployment can vary subject to disclosed numerical/platform constraints. |

Modelica's equation-based composition can introduce coupled unknowns and require solving systems rather than executing a topological process order. This small model uses a directed input/output envelope around one conservation equation; it does not demonstrate a multi-domain acausal network. Even here, replacing integration with “invoke Process once per tick” changes the numerical semantics and is not a faithful lowering.

FMI distinguishes Model Exchange (importer supplies solver), Co-Simulation (FMU supplies solver with a communication contract), and Scheduled Execution (model partitions with scheduling obligations). These are not interchangeable process implementations. SSP describes structure and parameterization of connected components. Our SSD contains one component with three connectors, enough to make the typed seam concrete but not to prove multi-FMU composition. The absent FMU must eventually export names, units and causality matching both Modelica source and SSD. XML well-formedness is weaker than SSP schema validation, and neither implies a solvable simulation.

RunPlantSimulation's request export binds model/assembly/calibration/scenario identities; the report input of RecordSimulation binds the resulting trajectory and diagnostics to the original request. Digest identities must include generated FMU bytes, model-description metadata, solver version and external dependencies once available. Request correlation, digest validation and failure classification are bridge obligations, not implemented by the ConceptIR declarations. No simulation report may claim success using the static interface-check report shipped here.

The proposed simulation-repeatability facet is justified for comparison with deterministic game replay and scientific workflows: all need pinned inputs and explicit comparison rules. Numeric tolerance, event alignment and floating-point platform sensitivity mean byte-identical replay is usually too strong for heterogeneous simulation. Begin with a provenance relationship and repeatability contract, then a simulation package; do not promote a generic continuous-time Process node. The sidecar does not alter concept-ir/2 or enforce any solver setting.

A time-step change may change result accuracy and therefore acceptance under a tolerance contract, even though selecting a specific integrator is realization. Requirement and mechanism remain separate. Calibration version is business evidence; solving for calibrated parameters is an external optimization problem whose result must return through the same provenance seam.
