# Replay and physics artifact boundary

`replay-envelope.json` is a descriptive test-contract sketch; it is not an executed replay report. VerifyReplay's request/commits/verdict inputs and replayRequest/checked outputs bind it to concrete ports. A real harness must persist canonical input batches, checkpoint bytes, random state and rules/solver/compiler/platform digests, then compare every committed tick.

The PhysicsEngine boundary remains separate: serialized collision results do not constitute a model of contacts, integration or floating-point behavior. No game engine or external solver was run. Exact digest equality is the proposed game profile's requirement, not a result obtained by this corpus.

`physics-interface.txt` records the separate numerical handoff, with session/tick/state/batch correlation and external integration/contact/precision obligations. It is neither an executable model nor evidence of successful simulation.
