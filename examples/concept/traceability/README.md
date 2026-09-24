# Traceability obligations and reconstruction evidence

These illustrative models declare the chain that must remain reconstructable, separately from the lineage data and evidence that may satisfy it. They are not industry compliance certifications.

| Model | Required chain |
| --- | --- |
| food | FinishedLot → IngredientLot → SupplierLot |
| automated-decision | AutomatedDecision → InputEvidence → ModelRevision |
| healthcare | TreatmentDecision → ClinicalEvidence → SourceRecord |

Each path names typed relationship roles, a requiring external constraint (which retains authority/jurisdiction/citations), a typed applicability predicate, effective validity, minimum retention, required identity attributes, and valid/knowledge-time obligations. Additional model/policy/reviewer paths can be independent requirements; there is no universal untyped reference or provider-specific field.

Two executable test adapters reconstruct the same witness: `*-graph.json` is a materialized lineage record/link graph; `*-journal.json` is an ordered evidence journal replayed into records and links. The latter is a finite append-only fixture, not a deployed event-store certification. Changing this strategy never changes the ConceptIR hash. Both satisfy the supplied finite reconstruction cases; mutation tests reject broken chains, missing attributes, stale contract hashes, short retention bounds, absent temporal evidence, and out-of-window witnesses.

`ConceptIR::check_trace_witness` checks normalized witnesses and `forgec concept check-trace <concept.json> <witness.json>` exposes the same check. A witness contains `conceptHash`, `requirement`, `at`, an evidence locator, an ordered record-ID `chain`, typed `records`, and role-bound relationship `links`. The tests show both normalization adapters. Retention is a minimum number of days after each record's `recordedAt`; all instants use epoch milliseconds. Applicability remains unevaluated and must be evaluated by the adapter in its business context.

This validates supplied observations, not evidence authenticity, completeness of an external repository, or guaranteed future retention. A claimed retainedUntil is not a storage-enforcement proof. Foundation Lineage/Evidence can supply corresponding typed links and evidence artifacts; their provider certification remains separate. No Foundation implementation is modified.
