# Concept boundary: medical-device

The supervisory interface is **B overall**, with **A** for approved-therapy identity and audit and **C** for specialized reactive execution, physical delivery and clinical safety. The fixture deliberately excludes dosage algorithms. No real device or treatment is specified.

| Concern | Layer / outcome | Decision |
|---|---|---|
| coordination | L0 / A | ApproveTherapy owns ApprovedTherapy; ReactToTherapyTick owns TherapyMode and TherapyDecision; PumpIO provides observations and accepts intent. |
| reaction-budget | L0 facet / B | Illustrative 5,000 us period, 2,000 us deadline and 800 us WCET budget are explicit requirements, not measured performance. |
| safe-modes | L0 facet / B | Inhibition, acknowledgement and nonautomatic restart are proposed domain obligations. |
| execution-strategy | L1 / B | A synchronous/model-generated supervisor and an independent monitor require an explicit realization. |
| deployment | L2 / B | Controller/watchdog independence, I/O placement and driver behavior require target-specific evidence. |
| specialized-semantics | external / C | State-machine execution order, motor/flow dynamics, dose accuracy and clinical safety cannot be inferred from the graph. |

## Requirement traceability is not compliance

ApprovedTherapy carries immutable revision identifiers as data; the structural fixture does not implement signature checks, clinician authorization or clinical prescription validation. TherapyDecision records which revision was considered. A production system must link each safety requirement to the exact specialized artifact, tool/version, platform assumptions and verification report. A passing reference/digest check can establish that a report refers to a particular artifact; it cannot establish that its claim is sound, sufficient or regulator-approved.

The safety requirement belongs to L0 when changing it changes the acceptable behavior. The algorithm for meeting it and the controller placement ordinarily belong to L1/L2. If a safety case demands an independent certified controller, that independence constraint becomes an explicit requirement; the chosen core/address still belongs to its realization. The current proposed facet does not implement any of those safety arguments.

## Official comparisons

[SysML v2](https://www.omg.org/spec/SysML/2.0/About-SysML) includes system structure and behavior with analysis and verification cases. That suggests linking requirement identities and evidence rather than embedding a complete systems-engineering language or certification workflow in ConceptIR. Traceability is a relationship first; a reusable facet should follow only when comparable obligations recur across unrelated domains.

[SCADE Suite](https://ansys.synopsys.com/products/embedded-software/ansys-scade-suite) documents model analyses and architecture/design synchronization. A generated supervisor could be an external realization artifact, but qualified tooling does not certify an arbitrary model or a complete device. [Stateflow](https://www.mathworks.com/help/stateflow/ug/overview-of-stateflow.html) supplies a relevant state-machine comparison; the official page was inaccessible with HTTP403 during research, so no precise transition-priority claim is drawn from it. [Simulink sample-time documentation](https://www.mathworks.com/help/simulink/ug/types-of-sample-time.html) was likewise blocked; physical pump simulation and sample-time assumptions remain unexecuted external work.

[AADL](https://www.sei.cmu.edu/projects/architecture-analysis-and-design-language-aadl/) provides architecture-level components and embedded-system analysis. The deployment sketch asks for scheduler, watchdog and I/O evidence rather than assigning safety to the mere existence of a Process. [AUTOSAR Classic](https://www.autosar.org/standards/classic-platform) is a comparison for application/interface/platform separation only, not a medical-device conformity requirement.

## Promotion decision and limits

The proposed timing facet shares its dimensions with flight-control and packaging-line, supporting a reusable requirement package rather than a new MedicalProcess node. All three require explicit clocks, deadline endpoints and independent detection of missed work. Their hazard responses differ: a generic failSafe Boolean would obscure that difference. The mode facet therefore proposes only vocabulary/startup/recovery obligations, with concrete transition semantics delegated to the selected model.

JSON parsing, closed references and numeric budget inequalities are offline consistency checks. They are not a WCET bound, scheduling proof, alarm-response test, device-safety validation or clinical recommendation. The watchdog needs independent implementation and analysis; a process that fails to run cannot be its sole missed-deadline detector. An inhibited intent does not itself establish that delivery stopped or that stopping is clinically appropriate.
