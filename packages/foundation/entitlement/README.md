# Entitlements and obligations

Experimental durable business rights and duties using Party identity. This package
is separate from participation, authentication, authorization and the ledger.

`Entitlements` exposes `issue`, `recordObligation`, `revoke`, `expire`, `renew`,
`endObligation`, `obligationAt` and paginated `listEffectiveRights`. Use domain-qualified
RightDefinition and RequirementDefinition records; EntitlementScope is a typed sidecar
handle, not a universal subject reference. Domain resources attach scopes and grant/duty
records using ordinary typed references.

All facts are append-only. Validity is `[validFrom, validUntil)`; a missing upper bound
is unbounded. A grant ceases to be effective at validUntil even when the optional explicit
expiry audit fact has not been recorded. Expiry facts must name that exact instant.
Revocation and expiry compete for one unique terminal fact. Querying before its effective
time preserves the prior historical interpretation. Recorded timestamps remain distinct
from effective times; these are effective-time queries, not a full bitemporal audit API.

Renewal creates a uniquely linked successor with the same holder, right, scope and unit,
starting at or after a finite predecessor's validUntil. It requires explicit new issuance
and does not reactivate or mutate the predecessor. Revoking a predecessor **does not revoke
its independently issued successor**. Applications needing agreement-wide cascading
revocation must define that policy above this substrate. Concurrent renewals arbitrate via
the unique predecessor claim; retries should retain their idempotency key.

Obligations are NotIncurred before incurredAt, Open thereafter, and Overdue at dueAt if no
terminal fact is effective. Discharged/Cancelled facts compete uniquely and retain actor,
reason and effective time. The package does not execute fulfillment or infer discharge
from a payment or workflow.

Quantities are optional nonnegative exact decimal strings with six-place storage scale;
a quantity and explicit unit must be present together. Values with excess precision,
negative values and unmatched quantity/unit pairs fail. No unit conversion or balance
calculation occurs. Domain wrappers may enforce stronger unit-specific rules, such as
whole seats. Rights and requirements never contain an authorization expression language.

The consumer fixture includes SoftwareSeat, WarrantyCoverage, CourseAccess and
ContractualDuty. Purchase provenance uses typed satellites. The application owns validating
and creating required provenance; a standalone grant does not imply its source satellite
was atomically created. Domain conditions belong in those typed wrappers too.

The `entitlementPipAuthorizer` bridge delegates to an independent policy and rereads facts
for every decision. Its caller must use a separately authorized fact service, authenticate
the actor, resolve current tenant-scoped Principal→Party representation, follow pagination,
and provide truthful observed/expiry times. Never recursively read through the protected
engine's own PIP bridge. Entitlement existence alone grants no authority; unknown or unreadable
terminal facts fail closed rather than looking absent.

Local tests use generated memory and SQLite bundles, including concurrent terminal and
renewal races, authorization separation, validity and representation revocation, and typed
consumer fixtures. Hosted D1, PostgreSQL and DynamoDB certification is not claimed.
