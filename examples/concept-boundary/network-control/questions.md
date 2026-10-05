# Falsifiable questions

1. Can a revision-4 receipt incorrectly satisfy a revision-5 ReconcileDecision? A realization must test exact revision/generation correlation.
2. Does every device apply expected-generation and controller-epoch fencing atomically? If not, document the weaker rollout contract instead of calling the logical single producer distributed exclusivity.
3. Under fixed desired intent, eventual delivery, reachable devices and fair retries, what decreases on each successful step? A convergence contract needs this argument or an explicit non-monotonic alternative.
4. What happens when an unreachable device reports an old generation after recovery? Preserve the sample/knowledge times and avoid rolling ObservedTopology backward.
5. Which part of a route objective is domain policy, and which is a replaceable algorithm? Changing the optimization objective is not merely an L1 rewrite.
6. Can an external model checker produce a counterexample with two controller epochs active? Link the artifact and trace to ApplyNetworkPlan; do not reinterpret graph validation as proof.
