# Boundary corpus authoring contract

Issue #88. This is a research corpus, separate from the business validation corpus (#69). Use current `concept-ir/2` unchanged. No new compiler node kinds or claimed timing/runtime/formal guarantees.

Each fixture directory contains `domain.md`, `concept-boundary.md`, `questions.md`, `concept-ir.json`, `boundary.json`, `specialized-model/README.md`, and `views/{concept,boundary}.mmd`. ConceptIR must load through the real Rust validator; use qualified `@boundary/<slug>/_/<Name>` IDs and closed typed references. Own each durable output from exactly one logical process; physical replicas are not separate semantic owners. Views must use actual declaration/concern names. Include concrete operations, exceptional behavior, and reasoned boundaries rather than only expected classification labels.

`boundary.json` format (all fields required):

```json
{
  "version": 1,
  "slug": "flight-control",
  "outcomes": ["B"],
  "concerns": [{"id":"reaction", "description":"...", "layer":"L0-facet", "outcome":"B", "conceptRefs":["@boundary/flight-control/_/React"], "pressures":["fixed-period"], "rationale":"..."}],
  "facets": [{"id":"reaction-budget", "kind":"timing", "status":"proposed", "targets":["@boundary/flight-control/_/React"], "parameters":{"periodUs":10000,"deadlineUs":5000,"wcetBudgetUs":2000}, "meaning":"...", "obligations":["...not a WCET proof..."]}],
  "realization": {"strategy":"...", "placement":"...", "limitations":["..."]},
  "artifacts": [{"id":"controller-model", "path":"specialized-model/controller.txt", "format":"SCADE sketch", "status":"sketch", "process":"@boundary/flight-control/_/React", "inputPorts":["..."], "outputPorts":["..."], "claim":"Interface only; no analyzer executed"}],
  "sources": [{"title":"Official reference", "url":"https://...", "supports":"Specific boundary claim"}]
}
```

Allowed layers: `L0`, `L0-facet`, `L1`, `L2`, `external`. Outcomes A=native, B=facet/pattern pressure, C=external semantic domain. L0=A, L0-facet=B, external=C; L1/L2 may accompany A/B/C. Outcomes must equal distinct concern outcomes. Empty facets/artifacts are allowed where justified. Artifact paths must exist; root generates digest-pinned handoff index. Port IDs must exactly match the corresponding Process input/output maps. Proposed facets live in this corpus sidecar, NOT ConceptIR JSON; they are unimplemented compiler/runtime requirements.

Pressure IDs: fixed-period, deadlines, deterministic-execution, wcet, modes, fail-safe, sensor-actuator, reconciliation, synchronous-dataflow, discrete-event, continuous-time, acausal-equations, replay, consensus, convergence, formal-verification, simulation-artifacts, hardware-placement, platform-mapping, traceability, resource-budgets, backpressure.

Timing facets use positive integer microseconds, wcetBudgetUs <= deadlineUs <= periodUs. Those inequalities validate a stated illustrative requirement, not schedulability or physical safety. Place at least one timing facet in flight-control, packaging-line, medical-device. Other facet kinds may be descriptive `replay`, `safety`, `resource-budget`, `mode`, `convergence`; parameters are domain data, obligations explicit. Every proposed facet needs real targets and a meaningful cross-domain promotion argument in prose.

Source references must point to relevant official systems/specification documentation with concrete comparison. Label inaccessible or unexecuted tooling honestly. Specialized sketches must not imply certified devices, implemented control laws, protocol proofs, or physical simulations. Root owns manifest, shared validators/tests, global README/synthesis and source index; agents own assigned fixture directories only.
