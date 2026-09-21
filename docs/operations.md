# Operations

## Telemetry and SLOs

Every logical operation (generated CRUD, functions, views, projections, caches,
workflows, schedules) emits one unsampled event: operation id, kind, resource,
outcome, status, code, duration, request id, trace context, per-process
sequence. Outcomes follow the compiled policy in `bundle.observability`:
`good` (< 400), `excluded` (client errors), `bad` (5xx, transient conflicts),
`business` (declared domain errors). Dimensions are only
`forge.operation`, `forge.kind`, `forge.resource`, `forge.outcome`,
`forge.target` — never tenants, ids or inputs.

- Cloudflare: structured JSON lines in Workers Logs (`{"forge":"operation",...}`).
- AWS: CloudWatch Embedded Metric Format under namespace `forge/<package>`:
  `forge.operation.count` and `forge.operation.duration_ms` by operation and
  outcome.

`traceparent` is honoured on requests and returned with the operation's span;
outbox rows carry the producing span so consumers can link. Export gaps are
counted (`engine.telemetry.stats()`); the emitter never fails an operation.

SLO descriptors (`availability`, `latencyGood`, `latencyWithinMs`, `window`)
live in the plan per operation class; histogram boundaries include the exact
threshold. They are editable targets, not achieved performance — see the
benchmark section of the certification report.

## Schedules

`GET /v1/schedules/<name>` returns the ledger (last occurrence, next, skipped).
`POST /v1/schedules/<name>/tick {now}` runs due occurrences (operators use it to
replay after an outage; providers call it on their triggers). A failed
occurrence is not marked done and re-runs on the next tick.

## Workflows

`GET /v1/workflows/<name>/{id}` shows status, bindings and history;
`POST .../{id}/cancel` records a terminal without undoing completed effects;
`POST .../signals/{message} {messageId, payload}` delivers a signal (channel
messages arrive automatically). Instances are pinned to `(version, graphHash)`;
a deployment with a different graph and the same version refuses to advance them
(`WorkflowVersionMismatch`) — bump `version` and let old instances drain.

## Projections and caches

`POST <projection path>/rebuild` builds a new generation from the source and
switches; `GET .../status` reports generation and last processed event. Cache
entries are recomputed on the next read after expiry; nothing is lost when a
cache is wiped.

## Provider switching (plan §22)

```
src.admin.fence(true)                 # stop writes on the source
snapshot = src.admin.export()         # canonical export (ids, versions, soft-delete state, hashes)
dst.admin.fence(true)
dst.admin.import(snapshot)            # identities and revisions preserved; claims/access items rebuilt
dst.admin.verify(snapshot).ok         # counts, hashes, references, revisions
src.admin.verify(snapshot).ok
dst.admin.fence(false); src.admin.fence(false)
```

Caches and projections are rebuilt on the new provider; blobs are copied by
digest; native workflow history is not moved. `conformance/test/switch.test.ts`
runs this live in both directions.

## Compatibility checks

`forge compat old/app.json new/app.json` reports per stream (api, interfaces,
event, storage, lifecycle, workflow, classification, governance, dependencies,
policy) with severities additive / migration / unknown / risk / breaking, a
direction (which side breaks) and needs, and exits 1 on breaking; `--report
pr|changelog|security` renders Markdown for an audience. `forge migrate old new`
turns the diff into a phased migration plan (exit 2 when a step blocks). Run
both in CI against the last deployed bundle (pull it from the registry by the
digest the deployment inventory reports).
