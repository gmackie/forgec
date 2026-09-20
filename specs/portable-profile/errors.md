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

## Classification rules for SLIs

- `MalformedRequest`, `ValidationFailed`, `UnknownField`, `Unauthenticated`,
  `Forbidden`, `NotFound`, `PreconditionRequired`, `VersionConflict`,
  `UniqueConflict`, `InvalidTransition`, domain errors: **excluded** from the
  availability denominator's failures (the request was correctly rejected).
- `TransientConflict`, `StorageUnavailable`, `DependencyUnavailable`,
  `Internal`, timeouts, exhausted retries: **failures**.
- `RateLimited`: counted separately as admission failures.
