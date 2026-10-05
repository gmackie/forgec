# Measurement and Performance

MetricDefinition pins dimension, unit and observation semantics independently of
telemetry backends. MetricSubject supplies a typed domain binding point. An
immutable MetricObservation records either an instant or a half-open interval,
exact six-decimal value, producer/source record and optional sealed evidence.
Business observations require an authorized producer; telemetry is not imported
or promoted automatically. Usage consumption and Evaluation runs remain separate.

`Measurements.record` writes samples. `derive` supports sums, sample-weighted
means, dimensionless products and ratios with compatible input units/dimensions.
Each derived row stores both input references. `observation` recursively verifies
that provenance and recomputes its value, rejecting forged derived rows, reused
inputs, depth beyond eight, more than 255 visited nodes, division by zero or any
result requiring rounding. Aggregations require the same exact metric, inputs
inside the enclosing window and nonoverlapping interval inputs. Means weight all
leaf samples equally; they are not duration-weighted means. Products/ratios require
aligned intervals. Explicit selection means missing telemetry is not presumed zero.

MetricObjective pins a policy, expected target, inclusive lower/upper thresholds
and period. PerformanceAssessment links an observation and optional completed
Evaluation. `assessment` returns actual, expected, signed variance and threshold
status. It rejects observations outside the objective period. Assessment does not
execute Evaluation or change the original measurement.

MetricBreachEvent is an occurrence candidate. `breach` verifies the underlying
assessment really breached and that the occurrence does not precede observation.
`effect` additionally validates a separate typed Fulfillment response. Raw CRUD
candidates are never sufficient authority for notifications, cases or remediation;
consumers must use these readers. Nothing runs a monitoring loop or sends notices.

Manufacturing tests build an OEE-like indicator by multiplying independent
availability, performance and quality ratios; OEE is not special-cased. Consumer
fixtures also cover service latency, clinical waiting time and agent performance.
Local tests cover memory, SQLite and PostgreSQL. Hosted ingestion adapters and
metric-specific statistical policy are application realization responsibilities.
