# LevelForge artifact production integration

This opt-in adapter implements the real `ArtifactProductionJobStore` port used by
`createArtifactProductionJob` and `runArtifactProductionJob` in LevelForge's recipe
package. The executable trace imports that application's actual graph compiler,
executor registry, filesystem job store and runtime. It does not substitute a
renamed Foundation fixture for application execution. `verification.json` pins
the inspected application revision and source-file digests.

At the application's existing store-injection call site:

```ts
const store = withFoundationProduction(
  createFileArtifactJobStore({ projectDir }), engine,
  { projectId, definition, evaluationSet, executor }, context,
);
const job = await createArtifactProductionJob(graph, registry, store, {
  provenance: { createdBy: userId, sourceRevision: exactCommit },
});
await runArtifactProductionJob(job.jobId, registry, store);
```

The Foundation definition is a SpecificationPin at `sourceRevision`; the project,
job, graph, attempt and each executor version become typed domain records. A
planned Evaluation exists before the application's awaited job-start save permits
executor execution. A resumed failed job creates a child Evaluation and preserves
the failed attempt. Completed jobs replay without executing their providers again.
A new already-executed job cannot be imported as a prebound execution.

The two stores are not one transaction. The app persists a job first and then the
adapter writes its Foundation mirror; a Foundation failure stops the awaited
runtime path. `load` reconciles a previously bound durable job, including a terminal
whose result mirror failed. It never reruns an executor to repair mirroring.
Applications must retain receipt keys for incomplete stages and keep one serialized
writer per job, matching the existing filesystem store's revision semantics.
This does not strengthen that store into a multi-process transactional database.

The trace covers actual execution, a failed/resumed executor, exact source pins,
parent run ancestry, replay, denied terminal write/recovery, tenant isolation and
rejection of post-hoc execution binding. Source roots and installed app dependencies
are required explicitly. No application repository was changed, deployed or
silently enabled; this is a runnable adapter at its existing opt-in seam. Foundation
stores execution provenance, not the application's arbitrary output payload, and
completion does not constitute asset review approval or production publication.
