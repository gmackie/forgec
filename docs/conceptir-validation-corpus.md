# ConceptIR validation corpus

Issue #69 is exercised by [the ten-domain corpus](../examples/concept/README.md) and `crates/forgegraph-semantic/tests/concept_corpus.rs`. The corpus builds on the composition doctrine in #68 using ConceptIR v2; it introduces no new primitive or experimental source grammar.

The authoritative artifacts are hand-authored ConceptIR JSON. Each domain has a stakeholder narrative, explicit producer ownership, generated overview/ownership/security/external views, two L1 architectural sketches with compilable partial signatures, semantic and realization-only mutations, invalid cases, and open modeling questions.

Run `cargo test -p forgegraph-semantic --test concept_corpus`. The normal test is read-only. To intentionally regenerate canonical JSON and graph snapshots, set `UPDATE_CONCEPT_CORPUS=1` for that command, then review the diff.

## Evidence limits

The [coverage matrix](../examples/concept/coverage.json) accounts for all 26 issue axes, with JSON Pointer anchors checked by the test. It distinguishes represented structure from explicit gaps. It does not equate a policy expression with enforced authorization, an as-of selector with a correct temporal query, a state type with keyed isolation, or a provider sketch with a working runtime.

All durable entities and facts have exactly one producer. This includes collaborative documents: users supply edit commands through an ingress process; MaintainDocument owns Document. The marketplace composes stateful dispatch with a state-machine lifecycle without inventing a Dispatch primitive. Airline feasibility intermediates use Shape-typed returns; runtime-defined SaaS objects use platform metadata and versioned payloads.

## Findings before freezing L0

The corpus identifies recurring gaps rather than resolving them through unchecked metadata:

- Banking, commerce and marketplace require arithmetic or cross-record invariants beyond Unique.
- Banking, benefits and insurance need precise validity/correction semantics beyond stored dates.
- Clinical, insurance and benefits decisions need evidence completeness and authorization/audit coupling.
- Manufacturing and marketplace require explicit event-time, staleness and late-data semantics without a stream-processing language in L0.
- Airline and marketplace now connect typed results through process-result origins with exact output/type validation. Actual execution remains unproven; no Value primitive was needed.
- Stateful dispatch needs a key/isolation contract with an actual tooling consumer.
- Collaboration retains one logical owner but still needs convergence and conflict-semantics evidence for CRDT/OT substitution.

Apply relationship → facet → pattern → domain wrapper before primitive promotion. A new primitive must have cross-domain evidence, demonstrate why composition loses meaning, pass the stakeholder English and semantic substitution tests, and have a concrete compiler/tooling consumer. No kernel expansion is proposed by this corpus.
