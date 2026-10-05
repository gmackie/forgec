# Reproducible computational experiment

A research team compares a numerical model across a finite parameter sweep. RegisterExperiment pins the protocol, dataset, parameter set and result-comparison policy. ExpandSweep emits individually keyed SweepMember facts; ExecuteMember requests an external HPC/GPU attempt and records its terminal report. RegisterArtifact verifies/registers content-addressed output manifests. CollectExperiment publishes which successful attempts were selected and whether every expected member was accounted for.

Parameter-set membership and the expected collection criterion are scientific meaning. Chunking that set into a Slurm job array, worker pool or CWL scatter is execution strategy. One logical ExecuteMember producer owns attempt records even when thousands of physical jobs run. Slurm array indices or job completion order are not experiment identities; memberKey and attemptKey survive queue retries and rescheduling.

A preempted attempt may expose a checkpoint but not a successful output. Resume pins that checkpoint, executable/container build and member inputs. A missing or hash-mismatched artifact blocks registration. A failed member prevents a complete collection unless the predeclared scientific policy explicitly permits omission; retries never silently replace the published member-selection digest. Numerical convergence and scientific validity are separate from operational job success.

The trace is a typed orchestration/provenance model, not an HPC submission, simulation or statistical analysis. Arbitrary arrays, files and solver internals remain artifact data outside the small ConceptIR graph. Resource estimates and reproducibility requirements are proposed sidecar contracts; no scheduler capacity or reproducible result is certified.
