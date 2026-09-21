# Provider cutover (FORGE-070)

Moving a deployment between providers (Cloudflare D1 ⇄ AWS DynamoDB ⇄ PostgreSQL/Node) moves
data and ownership explicitly. Recompiling for another target moves nothing.

## What moves, what is rebuilt, what stays

| kind | how |
|---|---|
| authoritative records (ids, revisions, soft-delete state) | canonical export → import behind a write fence → verify (counts, per-resource canonical hashes, references, revisions) on **both** sides |
| blobs | manifests (digest, bytes, media type) travel with their records; bytes are copied by digest and verified; a missing or mismatching object fails verification |
| unique claims, access items, subject indexes | rebuilt natively on the target through the normal commit path, never copied |
| projections, caches | rebuilt on the target from their sources |
| workflow instances and history | **provider-native; never translated.** The export reports how many are in flight (`excluded.workflowInstances`). Drain them on the source (let them finish) or restart them from a business checkpoint on the target. Nothing is fabricated. |
| idempotency receipts | not moved; replays after cutover run fresh (the receipt is provider-bound) |
| erased subjects | tombstones are part of the export and honoured on import: an erased subject's records are never revived by a restore (see M19) |
| revoked grants | revocation is registry state, not application data: rollback or re-import cannot restore authority (`GrantRegistry.isRevoked`, `DeploymentLedger.rollback`) |
| infrastructure state (Alchemy / CDK / Terraform) | handed off explicitly: the old stack is retained until the operator records the handoff; no automatic deletion of databases, tables or buckets, ever |

## Procedure

```
src.admin.fence(true)                 # writes stop on the source (503 WriteFenced)
snapshot = src.admin.export()         # export/1: records, blob manifests, excluded.workflowInstances
assert snapshot.excluded.workflowInstances == 0   # or drain first / restart from checkpoints
dst.admin.fence(true)
dst.admin.import(snapshot)            # identities and revisions preserved; claims rebuilt
dst.admin.verify(snapshot).ok         # both sides agree
src.admin.verify(snapshot).ok
copy blobs by digest; verify
dst.admin.fence(false)                # traffic moves (DNS / gateway) under the SLO gate
keep src fenced and retained          # restore suppression: the old provider is read-only evidence, not a fallback that resurrects erased or revoked state
record the IaC handoff                # old stack retained; deletion is a separate, reviewed step
```

`packages/runtime/test/postgres.test.ts` (PAR-146) runs the memory → PostgreSQL path with a sealed blob and
a live workflow instance; `conformance/test/switch.test.ts` runs it live between cloud providers.

## Rollback

Rolling code or data back never restores authority: revoked grants stay revoked and erased subjects stay
erased (PAR-145). A rollback is a rollout in the deployment ledger like any other, fenced and resumable.
