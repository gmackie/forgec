# Evaluation

An immutable EvaluationRun pins a SpecificationPin, an evaluation-specific executor,
a subject-owned EvaluationSet and optional existing parent. Strictly increasing
bounded depth prevents cycles and limits parent traversal to 64. Domain resources
point to the run and retain their own typed verdicts, measures, units and business
status. No shared Result or JSON observation is introduced.

EvaluationStart and EvaluationFinish are append-only facts. A unique finish permits
one terminal outcome, even under competing completion/cancellation. Completed means
execution completed, not that quality passed. Terminal facts determine phase even
if a raw start intent arrives later or races cancellation; they never reopen a run.
The helper refuses starts once a terminal fact is visible. Consumers must use phase()
rather than infer running status from start existence alone. Duplicate start/finish
retries use normal Engine idempotency keys. Terminal support pins EvidenceSeal, not
a mutable candidate list; the finish helper verifies all selected evidence is readable.

Typed fixtures cover change verification, LevelForge candidates, language-model
accuracy and manufacturing inspection. Definition changes never rewrite old runs.
Source/get/list authorization and hidden terminal facts fail closed. These are local
generated memory/SQLite results, not live-provider certification.
