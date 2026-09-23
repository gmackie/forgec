# ForgeGraph changeset assessment integration

This adapter invokes the actual ForgeGraph `summarizeChecks` CI event fold and
`isEligibleForAutoMerge` changeset-policy function. Its input uses the real
changeset, parent status, required checks, check-events v2 and build vocabulary.
`verification.json` pins the inspected revision and consumed source files.

An authenticated ForgeGraph CI caller can opt in after loading its changeset,
execution policy and build events:

```ts
const assessment = await assessChangeset(
  engine, { summarizeChecks, isEligibleForAutoMerge },
  {
    repositoryId, changesetId, buildId, headSHA, definition, evaluationSet, executor,
    changeset, policy, parentStatus, events,
  }, context,
  async () => (await loadChangeset(changesetId)).headSHA,
  () => new Date().toISOString(),
);
```

This is a **new assessment of historical CI observations**, not a claim that the
original CI provider execution was prebound. It pins source head, event digest and
policy/parent snapshot in ChangesetAssessment before starting the assessment
Evaluation. Source-head mismatch, absent/skipped/failed/scraped checks, an unfinished
stream, disabled auto-merge or an unmerged parent fail closed. Every required phase
needs an exact successful terminal for each observed stream. Empty required-check
policies cannot accidentally pass this stricter adapter. The app's actual fold and
policy function are executed inside the assessment.

A terminal mirror interrupted after Evaluation completion can resume with the
original build identity. Changed events or policy require a new build identity;
receipts reject reusing the same key for changed authority inputs. The source head
is reread before returning either a fresh or cached result. This read is not an
atomic merge condition: the real merge/deploy caller must retain its existing head
CAS, permissions and current policy enforcement. A returned eligible assessment is
not a merge or deployment, and this adapter never invokes either operation.

The caller remains responsible for authenticating event provenance and loading
trusted changeset/policy records. The opt-in adapter is exercised against the real
application functions and generated Foundation engine on memory, SQLite and local
PostgreSQL. It is not enabled in ForgeGraph production and does not replace the
application's attestation pipeline. No external service or application database is
required by the trace.
