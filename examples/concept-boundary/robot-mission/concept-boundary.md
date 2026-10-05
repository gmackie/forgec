# Robot boundary decision: A/B executive, C dynamics

| Concern | Classification | Why it belongs there |
| --- | --- | --- |
| Goal identity, revision, scene provenance and command decisions | L0 / A | Changing who owns Mission or what observation supports a decision changes meaning independently of middleware. |
| Hold/Stop modes, maximum stale-scene age and command lease | L0-facet / B | These constrain admissible behavior; they are orthogonal obligations, not new Process kinds. |
| Planner algorithm and ROS action/service adapters | L1 / A | Search/optimization and transport choices may change while the typed goal/candidate contract remains fixed. Choosing a different objective or feasibility condition would instead change L0 meaning. |
| CPU/GPU placement and onboard controller isolation | L2 / B | Allocation is a realization constraint. If a certified onboard stop path is mandatory, record that placement obligation; do not duplicate the executive producer on each processor. |
| Trajectory/control equations and plant dynamics | external / C | Continuous integration, collision geometry and stability use different composition laws from durable fact publication. |

Ptolemy II explicitly assigns models of computation to directors, including continuous-time, synchronous/reactive and discrete-event directors. A Mission→PlanAssessment edge does not import any of those firing or time laws. The external controller artifact owns its sampling law and plant model. ROS 2 managed-node lifecycle has Unconfigured/Inactive/Active/Finalized and transition/error states: useful implementation supervision, not the same state machine as Mission.mode. A ROS node being Active does not mean the mission is Executing or physically safe.

AUTOSAR Classic separates application software from its runtime environment/basic software, and Capella/Arcadia separates logical from physical architecture. The analogous boundary is Mission/AdvanceMission → executable coordinator/planner adapters → onboard CPU, GPU and actuator controller. No AUTOSAR compatibility or Arcadia model export is implemented here. The official pages were retrieved; those parallels are architectural comparisons, not certification.

Promotion test: a mode/freshness/lease facet is also plausible for medical and packaging controllers, so first propose a shared contract vocabulary with monitor/analyzer obligations. A trajectory node or continuous-time kernel primitive is not justified by this mission example. The artifact handoff binds actual process port IDs, model/configuration digests, coordinate frames and validity intervals. It proves neither safety-envelope adequacy nor solver feasibility.
