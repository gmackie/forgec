# Reachability (experimental)

LocatorSet is an application-owned typed sidecar: a CustomerAccount, a SupportService and a
FieldDevice each attach one, so reachability belongs to whatever owns it rather than assuming
a person. ContactPoint, Endpoint and their verifications and dispositions are append-only facts.

`Reachability` from `@forgegraph/runtime` provides declaration, verification, revocation,
supersession, resolution and paged listing. The application invokes these behind its own
authenticated, authorized surface; this package generates no HTTP routes. Normal Engine
authorization still applies.

Contact points and endpoints are separate resources, not one polymorphic locator, because a
data classification is a property of a field. A single `value` column would have to be
classified once: as `data.contact`, which sweeps webhook URLs into subject-rights erasure that
does not apply to them, or as structural, which under-classifies an email address. The
`personal` flag on LocatorKind decides which profile a kind belongs to, and a rule on each
profile enforces it, so an API URL cannot be filed as a contact detail even by mistake.

Uniqueness is tenant + set + kind + purpose + normalized value, and separately + preference, so
"the preferred billing address" is never ambiguous and two racing writers cannot both claim it.
Purpose separates otherwise identical values: the same address can be both billing and support
without colliding. Purpose is a reachability label, not a governance purpose and not a
notification preference — `billing` says which address to use for invoices, never whether the
subject agreed to receive them.

Validity is [validFrom, validUntil). A disposition ends reachability at effectiveAt. A
replacement must share the set and kind, start strictly later, and take effect at its own
start, which prohibits supersession cycles; disposition uniqueness makes conflicting
revoke/supersede attempts fail atomically. Verification is evidence about a locator rather than
a precondition for having one, so an unverified address is a usable fact and resolution reports
`verified` instead of hiding it.

Nothing about transport lives here. A locator says where something can be reached, never how a
provider delivers to it, what retry budget applies, or whether a message was sent. Delivery #38
and Notifications #50 own those, and a test asserts structurally that no field named for a
delivery mechanic has appeared in this contract.

Run `node scripts/verify-foundation.mjs --suite local --package reachability`. Tests use
generated bundles on memory and SQLite, covering profile separation, duplicate races, purpose
scoping, preference ordering, half-open boundaries, verification evidence, supersession and
revocation, idempotent replay and tenant isolation. The consumer fixture exercises a
Party-shaped owner and two non-Party owners on both adapters. Seven of the eight issue criteria
have executable local evidence in `contract.json`. Fixtures are synthetic, not production
adoption.

**F91-07 remains planned.** Notifications #50 owns `NotificationEndpointLink` over
`delivery.DeliveryDestination` today. Moving it onto this substrate changes that package's
contract digest and re-opens its own acceptance, so it is a change against #50 rather than
something this package can claim. The consumer fixture's `OutboundRoute` demonstrates the shape
— it holds a reference and restates no value, validity or verification — but a probe is not
adoption. Hosted provider certification is separate and is not claimed.
