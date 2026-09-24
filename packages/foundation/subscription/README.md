# Subscription / Membership

Subscription composes an existing issued Agreement and its exact entitlement link,
BillingPeriod, optional Allowance and ServiceLevel. It is not another authority or
billing engine. Each immutable term pins explicit accepted consent and a finite
coverage interval. Terms may subdivide one agreement or use an explicitly
succeeding agreement. Customer, scope and right must remain continuous.

`Subscriptions.act/state` uses a unique consecutive 128-event journal. Fixed terms
expire without renewal; autoRenew and evergreen profiles admit contiguous renewal
terms through the same policy checks. Evergreen means no configured final term,
not an infinite entitlement: the host scheduler must supply each valid next term
and its agreement/consent. No unattended job or implicit agreement is created.
Plan changes occur inside the current active term and preserve the old history.
Different right/scope products require a separately modeled subscription.

Suspension starts the configured grace interval, then disables the subscription.
Grace never extends a term or underlying entitlement. Resume is explicit. Cancel
has an effective instant: queries before it retain the previous state, and queries
at/after it return cancelled. A scheduled cancellation seals further journal
changes; undo requires a new subscription. Immutable scheduled events cannot be
inserted out of order. Expiry and agreement revocation always stop effective use.
Consumers must check `state.effective` together with the downstream authority;
subscription state does not mutate or revoke shared Agreement entitlements.

Allowance must cover its term and bind the issued right; effective queries consume
Quota's live usage projection. Billing periods match term boundaries. ServiceLevel
is an optional linked objective instance. `proration` validates a separately issued
Billing adjustment after an admitted change/cancellation, against the prior
agreement. Domain pinned pricing policy computes its amount; no implicit credit,
charge, payment or double-accounting occurs here.

SaaS, membership, telecom/media and service-plan consumers reuse the model.
Memory/SQLite/PostgreSQL tests cover all modes, accepted consent, continuous terms,
gap rejection, grace/resume, plan changes, timed cancellation, stale heads, quota
composition and isolation.
