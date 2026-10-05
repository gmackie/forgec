# Protocol boundary sketch

`epoch-fencing.txt` specifies a bounded analysis question for ApplyNetworkPlan and its typed decision/receipt/command/attempt ports. It is not TLA+ syntax and no TLC or model checker was executed. A future TLA+/PlusCal artifact would model command admission, epoch transitions, stale telemetry and receipt loss separately from ConceptIR's logical ownership.

The routing engine is external implementation software in this fixture, but algorithm choice alone is L1, not automatically a C semantic domain. The artifact sketches L1 validation under adversarial interleavings; this fixture remains A/B. A future full temporal-logic proof would add a distinct C concern. Its counterexamples would become test inputs/evidence, never authoritative operational observations.
