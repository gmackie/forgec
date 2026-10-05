# Boundary: architecture A, concurrent protocol semantics C

| Concern | Layer / outcome | Reason and changing assumption |
|---|---|---|
| logical-replication | L0 / A | Client command, committed projection, immutable receipt and single logical ownership survive replacing the protocol engine. |
| verification-record | L0 / A | Typed requests/reports and digest-bound evidence are ordinary discrete information. Replacing TLC with another analyzer preserves the admission seam if obligations remain explicit. |
| agreement | external / C | Agreement quantifies over possible executions. A dependency graph or local data invariant cannot establish temporal safety. |
| replica-execution | L1 / A | Raft/Paxos choice, retransmission and checker orchestration realize the contract; they have different proof obligations. |
| failure-domains | L2 / A | Hosts, zones and analyzer worker placement are execution details unless explicitly constrained by a failure-domain contract. |

ApplyCommitted owns ReplicatedState. No physical replica is modeled as an alternative owner. If shards have independent histories, ownership must instead be explicitly scoped per shard; pretending independently conflicting writes share one authoritative history would hide the actual problem. This example does not encode shard quantification.

TLA+ defines states, actions and temporal formulas; TLC explores a supplied finite instance. Raft's published model includes elections, log matching, leader completeness and state-machine safety. BoundedQuorum deliberately omits those mechanisms. Majority intersection plus write-once votes explains this model's Agreement result; removing the write-once guard allows a voter to endorse both values over time and can invalidate Agreement. No fairness property is checked, so a permitted stuttering execution may never decide. CHECK_DEADLOCK FALSE prevents terminal safe states being treated as errors; it does not establish progress.

The stable handoff is VerificationRequest -> TLC -> VerificationReport, with semantic port IDs in boundary.json. Requests pin both `.tla` and `.cfg`: changing either invalidates old evidence. `verification.json` records the actual bounded invocation, tool bytes, state counts and exclusions. The tool release URL is provenance, not sufficient identity; the downloaded jar reports a build timestamp and is pinned by SHA-256. A future bridge must attest that the checked abstraction refines the deployed protocol before advertising any implementation guarantee.

#74 may eventually carry a named safety obligation and reference its evidence. It should not embed a temporal-logic interpreter or treat successful bounded exploration as unbounded liveness. Promotion ladder: evidence relationship -> generic admission contract -> verification workflow pattern -> formal-tool package. The specialized model remains external. No consensus-specific kernel primitive or proposed generic facet is justified here.

An architecture view can compare protocols and failure-domain placement; it cannot select a correct leader-election rule from graph topology. The boundary is crossed when meaning depends on all adversarial interleavings or fairness, not merely when a process runs on several machines.
