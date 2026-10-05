# Questions and adversarial checks

- Does the one-slot implementation keep output stable for arbitrarily long stalls? Directed tests cover several cycles; formal induction or broader property checking would strengthen evidence.
- Does changing in_ready to unconditional readiness cause loss under backpressure? The shipped scoreboard should fail this mutation.
- What reset policy permits dropping a pending sample, and how are drops counted across reset? The current conservation claim excludes reset intervals.
- Would changing token rates from 1:1 to 2:3 require different capacity and scheduling? Compute a repetition vector and schedule before reusing any buffer claim.
- Can the generic resource-budget facet serve telecom queues without importing synchronous firing semantics? That comparison determines promotion scope.
- Which CDC structure and metastability assumptions apply if a second clock appears? No such crossing exists or is verified in this fixture.
