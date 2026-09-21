# The `portable-v1` profile

A build declares its targets; the compiler validates the whole program against
both capability manifests before emitting anything. Unsupported semantics are
compile errors with a location and an alternative, never a silent downgrade.

## Guaranteed identical on both clouds

- Canonical API: paths, methods, JSON wire format, Problem Details errors with
  the same codes, ETags / `If-Match` / `412`, `Idempotency-Key` receipts,
  opaque cursors, page limits (default 50, max 100).
- Validation and normalization: one codec implementation contract
  (`specs/codecs`, golden vectors run in Rust and TypeScript).
- Mutation semantics: optimistic concurrency, atomic unique claims, race-safe
  reference and rule checks, restrict-delete, soft delete with key retention,
  audit + outbox staged in the same commit, exactly-one-commit-per-receipt.
- Changesets: propose / preview (diffs + budget) / approve (binds the hash) /
  commit, atomic (≤ 10 logical mutations, physical budget reported) or
  resumable per row.
- Blobs: intent → signed upload → finalize (digest verified) → immutable
  download; CSV import staging into a changeset.
- Messaging: one durable delivery per logical subscription, per-subscription
  progress, poison rows parked and redrivable, consumer dedup by message id.
- Views, projections (contribution ledger, rebuild generations), caches
  (`freshUntil`, effective-boundary aware), effective dating, hierarchy.
- Workflows: sequence / choice / bounded parallel / sleep / wait with
  correlation, typed error branches, timeout vs signal → one terminal outcome,
  activity idempotency across retries, version pinning, cancellation that never
  claims to undo completed effects.
- Schedules: recurrence IR, occurrence ledger, catch-up, overlap policy.
- Realtime: text JSON frames ≤ 64 KiB, per-stream sequence numbers, bounded
  replay (256) with explicit gaps, at-least-once.
- Telemetry: one event per logical operation with bounded dimensions and the
  same SLI classification.
- Provider switching: canonical export / import / verify behind a write fence.

## Deliberately not promised

- Byte-identical ids, timestamps, cursors, signed URLs, physical schemas.
- Cross-provider atomic transactions or exactly-once delivery through
  disconnects.
- Preserved WebSocket connection identity (clients resume by position).
- Portability of native workflow history (instances drain on the old provider
  or restart from a checkpoint).

## Declared limits (enforced, see `conformance/scenarios/limits.json`)

| limit | value |
| --- | --- |
| page size | 1..100, default 50 |
| atomic changeset | 10 logical mutations, then the provider's physical budget (100 D1 statements / 100 DynamoDB actions) |
| request body | 1 MiB (64 MiB for admin import) |
| realtime frame | 64 KiB |
| replay window | 256 frames per stream |
| schedule catch-up | 3 days |
| bounded working set | 1,000 records per list traversal |

Physical costs per logical operation differ (a create is ~5 D1 statements and
~6 DynamoDB actions); the changeset preview reports the real bound for the
provider it runs on. Measured latencies are in `conformance/certification/latest.json`.
