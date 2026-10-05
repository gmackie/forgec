# Boundary: job records A, stream obligations B, clock/dataflow execution C

| Concern | Layer / outcome | Why |
|---|---|---|
| validation-provenance | L0 / A | Build request, report and immutable receipt fit existing typed processes and artifacts. |
| stream-budget | L0 facet / B | Rates, occupancy limits and loss rules express required observables, but need an external checker. |
| clocked-execution | external / C | Simultaneous edge updates and ready/valid transfer semantics cannot be inferred from graph edges. |
| dataflow-schedule | L1 / C | SDF balance/scheduling or an elastic HDL network realizes the stream requirement. |
| clock-domain-crossing | L2 / C | Physical clocks, reset and metastability require explicit CDC implementation and analysis. |

Ptolemy II makes the model of computation explicit through directors. Its SDF director uses fixed production/consumption rates; for edge A -> B, a balanced repetition vector must satisfy qA * production = qB * consumption. With rates 1:1, equal firings balance. If A emits two tokens per firing and B consumes three, the smallest positive counts are qA=3 and qB=2. Buffer capacity additionally depends on the schedule and initial tokens; balance alone does not prove a one-token buffer sufficient or rule out deadlock in a cyclic graph.

Our ready/valid RTL is elastic clocked hardware, not a full SDF implementation. Each accepted transfer carries one sample, but downstream stalls make cycle-level throughput variable. In_ready = !out_valid || out_ready enables simultaneous consume/replace without increasing occupancy. The simulator's nonblocking register updates define which sample is observed on an edge. Reordering these as ordinary application invocations could lose a sample. Thus a generic execution-profile name without its laws would hide rather than solve the semantic gap.

The proposed stream-capacity resource-budget facet has a cross-domain candidate in game input queues and telecom reconciliation backlogs: finite capacity, admission and loss rules matter there too. Static firing rates and clock-edge semantics do not generalize automatically. Promote only generic capacity/overflow obligations as a contract, place stream scheduling in a domain package, and retain HDL/Ptolemy artifacts externally. No new ConceptIR node kind is proposed.

Logical ValidatePipeline ownership is independent of implementation on FPGA or ASIC. Clock period, reset topology, placement constraints, static timing, synthesis and CDC checks require external artifacts; none are implied by passing directed RTL simulation. If a clock boundary or certified device identity is itself a contractual requirement, preserve that requirement as evidence and map it to placement without placing physical registers in L0.

The handoff maps PipelineRequest input and export ports to exact RTL/testbench identities; PipelineReport enters RecordPipelineValidation and produces a durable result and receipt. A future adapter must validate request/source/tool identity, status, trace digest and assertion list before admission. The supplied verification.json is a bounded execution receipt. ConceptIR currently describes those relationships; it does not execute the toolchain or enforce the proposed facet.
