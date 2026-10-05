# Questions and falsifiable follow-ups

- Can a duplicate certificate produce two CommandCommitted facts? The future bridge needs an idempotent admission key and a regression test; declaration ownership alone does not settle this.
- Does changing three voters to four preserve the invariant for strict majorities? Run a new digest-bound config; never reuse the three-voter report.
- Does removing the write-once guard yield a counterexample? A mutation check can establish that the Agreement assertion is not vacuous.
- What refinement relation connects CommitCertificate to a real protocol's quorum, term and membership state? Until supplied, checked abstraction evidence must remain separate from runtime admission.
- What failure detector, fairness and eventual synchrony assumptions would justify liveness? They are intentionally absent; “all invariants pass” is not an answer.
- Would a generic verification-evidence contract also serve medical-device assurance and scientific provenance without incorporating any analyzer language? That is the cross-domain test for promotion.
