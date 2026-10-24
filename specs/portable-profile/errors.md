# Error taxonomy (portable-v1)

Every failure has exactly one `code`. Codes are the cross-provider contract;
HTTP status is the HTTP binding of a code; Effect error types are the typed
binding. Provider adapters translate raw provider failures into these; they
never invent new ones.

| code | HTTP | retryable | meaning |
| --- | --- | --- | --- |
| `MalformedRequest` | 400 | no | body is not canonical JSON, wrong content type, bad framing, over size limit |
| `Unauthenticated` | 401 | no | no trusted principal |
| `Forbidden` | 403 | no | principal lacks the operation or tenant |
| `CapabilityDenied` | 403 | no | a capability gate refused what the code reached for: the linked closure does not hold that capability (see below) |
| `NotFound` | 404 | no | record absent in this tenant (never reveals other tenants) |
| `MethodNotAllowed` | 405 | no | |
| `ValidationFailed` | 422 | no | field/row/relationship rule violation; `fields[]` populated |
| `UnknownField` | 422 | no | write to undeclared or server-owned field (`fields[]` names them) |
| `PreconditionRequired` | 428 | no | missing `If-Match` / `expectedVersion` |
| `VersionConflict` | 412 | no | expected version does not match |
| `PreconditionContradiction` | 400 | no | header and body preconditions disagree |
| `UniqueConflict` | 409 | no | unique claim held by another live (or retained soft-deleted) record; `constraint` set |
| `ReferenceMissing` | 422 | no | referenced record absent, inactive, or in another tenant |
| `HasDependents` | 409 | no | restrict-delete blocked by live references |
| `InvalidTransition` | 409 | no | lifecycle action not allowed from current state |
| `AlreadyDeleted` / `NotDeleted` | 409 | no | soft-delete state mismatch |
| `IdempotencyMismatch` | 409 | no | idempotency key reused with a different request hash |
| `InvalidCursor` | 400 | no | cursor undecodable, expired, or for another query/tenant/contract |
| `BudgetExceeded` | 422 | no | atomic changeset exceeds compiled physical budget; `detail` reports the bound |
| `PayloadTooLarge` | 413 | no | body/record/message over envelope |
| `RateLimited` | 429 | yes | admission control |
| `TransientConflict` | 503 | yes | provider operational conflict after bounded retries (Dynamo `TransactionConflict`, D1 busy) |
| `StorageUnavailable` | 503 | yes | provider unavailable / timeout |
| `DependencyUnavailable` | 503 | yes | declared external dependency unavailable |
| `Internal` | 500 | no | invariant violation; always logged with request id |

Declared function errors (`errors { SiteDisabled PaymentDeclined }`) are
**domain** errors: code = `<function stable id>.<name>`, HTTP 409 unless the
declaration maps otherwise, `retryable: false`.

## `CapabilityDenied`

A composable-units linker runs each entry point's closure with only the
capabilities its Closure Manifest declares. When the code reaches for one the
closure was not linked with, the gate refuses it and the request fails with
`CapabilityDenied`. It is a policy decision about the deployment, not about the
principal (that is `Forbidden` / `NotPermitted`), and not an outage: the same
request fails the same way until the manifest grants the capability or the code
stops reaching for it, so it is never retried and never reported as
`StorageUnavailable`.

The problem body carries the refusal in three extensions:

| member | always | value |
| --- | --- | --- |
| `capability` | yes | what was refused: `resource:<resource id>#read` or `#write` (a table the schema maps to a resource), `table:<name>#<mode>` (runtime or system tables), `sql:unclassified` (a statement the gate cannot classify), `binding:<type>:<name>` (a handle declared for other entry points, e.g. `binding:r2:BLOBS`), `egress:<origin>` |
| `entryPoint` | when the gate knows it | the entry point whose closure was refused, as `<kind>:<id>` (dynamic linker) or the packed script name |
| `unit` | when the gate knows it | the unit that reached |

```json
{ "type": "https://forge.dev/errors/capability-denied", "title": "Capability denied", "status": 403,
  "code": "CapabilityDenied", "detail": "http-route:POST /v1/orders/{order}/submit has no capability to write order_",
  "requestId": "…", "retryable": false,
  "capability": "resource:@acme/commerce/_/Order#write", "entryPoint": "http-route:POST /v1/orders/{order}/submit" }
```

Gates throw `capabilityDeniedError(denial)` (`@forgegraph/runtime/errors`).
The denial is encoded in the error message, which is all a Workers RPC hop
keeps, and the runtime's storage, object-store and HTTP layers recover it with
`asCapabilityDenied` before any provider-failure mapping.

## Classification rules for SLIs

- `MalformedRequest`, `ValidationFailed`, `UnknownField`, `Unauthenticated`,
  `Forbidden`, `CapabilityDenied`, `NotFound`, `PreconditionRequired`, `VersionConflict`,
  `UniqueConflict`, `InvalidTransition`, domain errors: **excluded** from the
  availability denominator's failures (the request was correctly rejected).
  `NotPermitted` and `CapabilityDenied` events also record `decision: "deny"`,
  and `code` tells a capability refusal apart for alerting on link defects.
- `TransientConflict`, `StorageUnavailable`, `DependencyUnavailable`,
  `Internal`, timeouts, exhausted retries: **failures**.
- `RateLimited`: counted separately as admission failures.
