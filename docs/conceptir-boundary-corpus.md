# ConceptIR boundary corpus (#88)

This corpus asks **where ConceptIR should stop**, independently of #69's test of business-domain expressiveness. Its ten authored ConceptIR v2 models describe discrete coordination. Boundary sidecars classify the remaining concerns and propose facets without adding fields to the compiler schema.

The fixture root is [`examples/concept-boundary`](../examples/concept-boundary/). Each fixture has a problem narrative, a layer-by-layer boundary argument, typed ConceptIR, a machine-readable concern map, proposed requirements, questions, specialized artifact interfaces, and diagram sources. The real semantic loader validates the models. Generated graph and handoff snapshots bind the artifact bytes and exact process ports.

## Reading the classifications

A means the existing kernel can express the stated **coordination contract**. It does not mean Forge implements the entire domain or proves its properties. B means a reusable facet/pattern is needed to preserve meaning, while the entity/fact/process structure still fits. Those proposals live in `boundary.json`, not the ConceptIR JSON. C means the concern depends on different composition or execution laws and belongs to a specialized semantic system.

A fixture can contain all three outcomes. A robot mission has discrete goals and commands, timing/safety-envelope requirements, and continuous control. A consensus service has typed architecture and administrative intent while its protocol safety and liveness require a model of adversarial interleavings. Flattening either into a single label hides the useful boundary.

The five layers are:

| Layer | What belongs here | What does not follow |
| --- | --- | --- |
| L0 ConceptIR | Typed durable state, occurrence facts, activations, process ports, external contracts, one logical authority | Correct control laws, schedulability, distributed agreement |
| L0 facet/pattern | Intended periods/deadlines, mode restrictions, replay requirements, resource/safety obligations | Compiler support or enforcement merely because a sidecar records them |
| L1 realization | Schedulers, algorithms, numerical solvers, queues, replay logs, workers and channels | Permission to change a declared timing or output contract |
| L2 placement | CPU/ECU/region/network assignments, deployment replicas and physical isolation | New semantic producers for every replica |
| External semantic domain | Continuous/acausal physics, synchronous hardware/dataflow laws, formal protocol transition systems | Arbitrary opaque claims with no typed interface, identity or evidence |

A requirement to use a particular certified controller can be L0 meaning; ordinary CPU allocation is L2. The test that changes placement only applies to the latter, not to an explicitly declared business constraint.

## Evidence and reproducibility

Run `cargo test -p forgegraph-semantic --test concept_boundary --locked`. The default run requires all ten fixtures and all 22 pressure categories. `BOUNDARY_FIXTURE=<slug>` is an authoring convenience; it is not whole-corpus acceptance. `UPDATE_BOUNDARY_CORPUS=1` regenerates the graph, handoff and pressure snapshots; rerun without it before review.

The checks load actual ConceptIR v2, reject invented kernel fields, resolve typed references, validate concern/facet anchors and exact handoff ports, hash specialized artifact bytes, and require three unrelated timing witnesses. They exercise accepted observations and late release/deadline/execution-budget counterexamples against the declared microsecond requirements. These are finite **synthetic observation checks**, not measured device timings, WCET analysis, schedulability proof, or safety certification. Passing inequalities are necessary conditions for the chosen periodic example, not a general real-time theory.

Changing proposed L0 requirement meaning changes the corpus semantic hash. Changing an ordinary realization/placement description leaves it unchanged. The hash is a research-sidecar distinction; it is not an extension to `ConceptIR::content_hash` or an implementation of #74/#75. Handoff snapshots bind actual model file digests to process input/output ports. They are local reproducibility evidence, not signed tool attestation.

Specialized execution evidence is recorded in the owning fixture. Bounded analyzer runs demonstrate how Forge can reference a model, carry its exact inputs, and retain its results. They do not prove a deployed system refines the model. Unavailable tools and unexecuted sketches remain explicitly labeled.

## Acceptance evidence

| Issue #88 requirement | Reviewable evidence |
| --- | --- |
| Ten narratives, outcomes and boundary maps | [Fixture index](../examples/concept-boundary/README.md); each `domain.md`, `concept-boundary.md` and `boundary.json` |
| Three unrelated timing/reactive witnesses | Flight-control, packaging-line and medical-device timing proposals; finite positive/negative trace checks in the Rust harness |
| Formal-method handoff | [Consensus model and offline TLC runner](../examples/concept-boundary/consensus/specialized-model/README.md): 41 distinct states, three invariants, explicit finite bounds |
| Physical-model handoff | [Digital twin Modelica/SSP interface](../examples/concept-boundary/digital-twin/specialized-model/README.md): static checks only; no FMU or simulation claimed |
| Logical-to-placement pressure | Control fixture AADL sketches and each fixture's L1/L2 classifications |
| Synchronous/dataflow pressure | [Hardware boundary argument](../examples/concept-boundary/hardware-dataflow/concept-boundary.md), elastic RTL and directed backpressure test |
| Cross-domain promotion discipline | Proposed timing/replay/resource requirements; no new kernel primitive |
| Explicit exclusions and integration | Specialized artifact digests and ports; conclusions below; [22-pressure matrix](../examples/concept-boundary/pressure-matrix.md) |

## Decisions on the open questions

| Question | Corpus conclusion and limit |
| --- | --- |
| Explicit model-of-computation kernel profile? | Not justified yet. Periodic coordination in flight control, packaging and medical devices shares requirement vocabulary, but synchronous HDL/dataflow and acausal physics change execution laws. Keep the latter external; investigate a domain profile before any new kernel kind. |
| Periodic activation and deadlines? | Their required values are meaning when changing them changes intended behavior. Clock delivery, jitter control and schedulers are realization choices. A typed external tick is an activation seam, not a timer guarantee. |
| Contracts for safety/timing/resources? | Record obligations and evidence boundaries as orthogonal facets. A small contract surface can name required properties without importing a formal logic engine; claim no proof until the appropriate analyzer has checked the pinned realization/model. |
| Distinct L2 IR? | There is concrete pressure from control devices, hardware clock/placement, and replicated services. This corpus records explicit mappings but does not justify a new universal IR by itself. Preserve separation first. |
| Stable specialized artifact identity? | Give every artifact a logical ID, exact content digest, format, typed process ports, tool configuration and bounded result/claim. Replacing bytes invalidates handoff evidence. A path or friendly name alone is insufficient identity. |
| Generate verification obligations? | Named requirements can be exported as tool-specific obligations. Automatic sound translation is a separate implementation and proof obligation; the corpus does not assume arbitrary ConceptIR contracts translate to TLA+, AADL or SCADE. |
| One logical producer with replicas/controllers? | Keep authoritative desired intent separate from observed reports. Multiple physical replicas may realize one logical producer, but ownership alone proves neither convergence nor consensus. Adversarial protocol behavior remains external. |
| Synchronous dataflow boundary? | Token rates, simultaneous reactions, buffer/backpressure, clocks and fixed-point/combinational behavior define execution laws. A Process dependency graph omits those laws. Keep an explicit SDF/HDL model and typed orchestration seam. |
| Deterministic replay facet? | A plausible reusable requirement for authoritative games, science and reactive controllers. It must bind ordered inputs, randomness, logical time, numerical/tool versions and observable outputs; an event log alone is insufficient. |
| Requirement/verification traceability? | Stable requirement and evidence references help ConceptIR orchestration. Requirements decomposition, physical allocation and system-wide verification management remain SysML/Arcadia-class concerns. Imported references are preferable to a second systems-engineering ontology. |

## Follow-up work

The corpus's strict reference checks are local to its test harness. [#111](https://github.com/gmackie/forgec/issues/111) tracks exposing closed-model validation separately from partial ConceptIR loading, which intentionally retains diagnostic reference nodes. Proposed contract implementation belongs with [#74](https://github.com/gmackie/forgec/issues/74); this corpus supplies witnesses and boundaries, not runtime enforcement. Executable physical simulation still needs the FMU, solver and validation steps listed in the digital-twin handoff.

## Promotion and explicit exclusions

No new kernel primitive is proposed by this corpus. The repeated pressure is for small timing, mode, deterministic replay, safety-obligation and resource-budget facets, with domain-specific validation and realizations. Promote in order: typed relationship, contract/facet, reusable pattern, domain profile/package, and only then a kernel primitive with multiple unrelated witnesses. A specialized external model is often a better endpoint than kernel promotion.

ConceptIR is not intended to become an acausal equation solver, a control-law design language, a hard-real-time scheduler, a temporal-logic model checker, an HDL synthesis language, a distributed consensus proof, or a replacement for systems-engineering traceability tools. It can describe the discrete intent, inputs, ownership and outcome of work performed with these tools while preserving where their guarantees actually come from.
