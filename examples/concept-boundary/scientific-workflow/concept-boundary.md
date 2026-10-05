# Scientific boundary decision: A/B orchestration

| Concern | Classification | Reason |
| --- | --- | --- |
| Experiment identity, sweep membership, attempt provenance, artifact and collection facts | L0 / A | These define what experiment was performed and what evidence supports its reported result. |
| Reproducibility envelope and resource/deadline obligations | L0-facet / B | These are reusable constraints, with explicit result equivalence and failure handling. |
| Scatter/gather implementation, checkpoint retries and queue adapters | L1 / A | Map/collect is a realization pattern when the member set and completeness rule remain fixed. Adaptive search that changes the scientific protocol requires a new L0 revision. |
| CPU/GPU partition, MPI ranks and storage locality | L2 / B | Allocation/placement can vary within the declared numerical reproducibility envelope. |
| Numerical executor and its declared result acceptance | L1 / B | Invoking a pinned program is a native External boundary. This fixture does not define physical equations or a new numerical model of computation. |

CWL v1.2 explicitly models workflow steps, scatter and output combination; it is a credible L1 workflow artifact, not evidence that every dynamic fanout must become a ConceptIR primitive. Slurm job arrays provide indexed scheduling, with documented ordering caveats and requeue behavior. The contract therefore pins member keys independently of job IDs or completion order. Workflow Run RO-Crate's Process Run profile distinguishes prospective software/tool descriptions from retrospective CreateAction provenance with object/result/instrument relationships; our AttemptRecorded and ArtifactRegistered carry corresponding boundary identities without claiming RO-Crate conformance.

Ptolemy II again warns against equating graph shape with execution law. A DAG of durable experiment facts does not imply synchronous dataflow token rates, MPI collectives, a discrete-event simulator or continuous numerical integration. Those laws, if required by a particular experiment, stay in its specialist artifacts. Calling an HPC executor alone is not evidence for classification C. This fixture only orchestrates pinned programs and records their declared output acceptance; a PDE/physical-equation model would be a separate C concern. Ordinary ConceptIR can orchestrate a solver and record its version without absorbing its equations.

Replay promotion has cross-domain evidence from games, but scientific reproducibility may mean a declared tolerance/confidence test rather than bit-identical output. The comparisonPolicyDigest must pin that choice in L0. A shared facet may bind inputs, executable, environment and verification evidence; it should not impose a universal equivalence relation. Resource budgets likewise describe an obligation, not proof a GPU kernel will meet a wall-time limit.

Capella/Arcadia's logical-to-physical separation helps distinguish a logical ExecuteMember from the CPU/GPU execution allocation. Changing node placement is L2 unless a device/precision requirement changes the experiment's valid result envelope. No new ConceptIR node kind is warranted by this fixture.
