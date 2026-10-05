# Network boundary decision: A/B coordination

| Concern | Classification | Reason |
| --- | --- | --- |
| Desired revision versus observed generation and applied receipt | L0 / A | Distinct facts and ownership prevent an accepted command from being treated as observed configuration. |
| Reconciliation progress and staleness bounds | L0-facet / B | A reusable convergence contract can state quiescent-intent/delivery/fair-retry assumptions and measurable obligations. |
| Routing algorithm, retry queue and partitioned worker ownership | L1 / A | Shortest-path implementation or worker queue is replaceable under unchanged policy and decision semantics. Route feasibility objectives themselves belong in L0. |
| Controller replicas, regions and device shards | L2 / B | Placement/failover preserves one logical AdmitIntent, ObserveDevices, ReconcileNetwork and ApplyNetworkPlan owner each. |
| Epoch fencing and adversarial integration scenarios | L1 / B | Implementation must validate command admission. This fixture states trace obligations rather than claiming a formal proof of a protocol. |

RFC 8342's NMDA distinguishes intended configuration from operational state, including configuration actually in use and origins. NetworkIntent and ObservedTopology adopt that distinction, but do not claim to implement NETCONF/YANG or all NMDA datastores. Telemetry generation must not be confused with intent revision. A delayed successful receipt for revision 4 cannot establish convergence to desired revision 5.

Ptolemy II demonstrates that an identical component graph can obey different firing/time laws. Reconciliation here is discrete invoked work with persisted observations; it does not acquire synchronous-dataflow rates or discrete-event simulation semantics. Algorithmic routing can stay ordinary computation in L1; modeling physical radio propagation or formally proving routing protocols would be distinct external work, not a reason to promote every topology edge into a new kernel primitive.

Capella/Arcadia's logical/physical distinction and AUTOSAR's application/platform separation motivate keeping controller process identity distinct from shard/region scheduling. A process has one logical producer even if leadership changes. The L1/L2 realization must provide fencing and command admission; the sidecar's controllerEpoch field is not an implemented lease protocol.

Promote reconciliation first as a pattern of typed intent, observation, command and receipt, then a convergence facet if this and robot/scientific retry cases share useful obligations. The protocol trace sketch is an external artifact of L1 verification, not itself a different semantic kernel. If a temporal-logic safety/liveness proof is required, that separate C obligation belongs to a specialist model (as in the consensus fixture). No convergence or consensus guarantee is validated by JSON loading.
