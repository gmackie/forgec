# reachability substrate contract

Implemented experimental package; acceptance evidence is recorded per criterion in `contract.json`. Local verification covers generated memory/SQLite runtimes and typed consumers. It does not certify hosted providers.
Logical Forge identity: `@forgegraph/foundation/reachability`. Initial release target: experimental `0.1.0`.
Source: [issue #91](https://github.com/gmackie/forgec/issues/91), under [epic #25](https://github.com/gmackie/forgec/issues/25).

## Ownership and identity

- LocatorSet: sidecar attached by canonical application resource
- ContactPoint: personal locator with purpose, preference, validity and supersession
- Endpoint: system locator with purpose, preference, validity and supersession
- Verification: evidence that a locator reached who it claimed to

LocatorSet is the substrate handle; there is no universal owner pointer and no global locator lookup. An owner may be a Party, a Service, a Device or a Place — the set does not know which, and the domain resolves its typed owner. ContactPoint and Endpoint are separate resources because data classification is a field property, not a row property: LocatorKind's `personal` flag decides the profile and a rule on each enforces it. Active -> Superseded or Revoked; expired validity is evaluated at query time. Reuse of a released value requires an explicit policy revision, not an implicit expiry side effect. No numeric quantity semantics.

## Dependencies and composition

Frozen direct substrate dependencies: none.
Normal Forge imports and `uses` reference accepted package-qualified contracts. The application explicitly co-deploys the selected durable package closure into one transaction domain. Import alone must not imply remote reference integrity. Domain wrappers own business payloads and any reverse provenance links. No universal EntityRef, arbitrary JSON payload, generic Task/Case/Result schema or additional import edge is authorized by this contract.

Notifications #50 and Delivery #38 are intended consumers: they select a locator and own everything about sending to it. This contract authorizes no reverse edge — reachability never learns whether a message was delivered.

## Commands and queries

These are required semantic operations, not a claim that callable implementations exist:

- DeclareContactPoint(set, kind, purpose, value, preference, validFrom?, validUntil?)
- DeclareEndpoint(set, kind, purpose, value, preference, validFrom?, validUntil?)
- VerifyLocator(locator, verifiedAt, method, evidence)
- SupersedeLocator(old, replacement); RevokeLocator
- ResolveLocator(set, kind, purpose, at); ListBySet

## Invariants

- Contact points carry personal data and endpoints do not; the kind registry's personal flag decides, enforced by a rule on each profile rather than by convention
- Uniqueness is tenant + set + kind + purpose + normalized value, and separately + preference, so a preferred locator is never ambiguous
- Validity uses half-open intervals; an expired window is unreachable without any disposition
- Supersession is explicit history: a replacement shares the set and kind, starts strictly later, and takes effect at its own start, so chains cannot cycle
- Reachability says where something can be reached and never whether it should be: consent, notification preference and delivery mechanics are separate facts owned elsewhere
- Tenant isolation, declared capabilities and normal governance apply to every operation, reference and read surface.
- Commands retain idempotency identity and reject conflicting replay; terminal history cannot be erased by exposed CRUD.
- Existing instances retain immutable references across compatible package evolution.

## Acceptance traceability

Every issue checkbox appears verbatim below and in `contract.json`; IDs are stable and statuses record local verification. Verification kind names describe required evidence, not executed checks.

| ID | Kind | Required evidence | Status |
| --- | --- | --- | --- |
| F91-01 | runtime | Email/phone/postal contact-point examples. | passing (local) |
| F91-02 | runtime | API/MCP/webhook endpoint examples. | passing (local) |
| F91-03 | runtime | Validity/supersession semantics. | passing (local) |
| F91-04 | runtime | Verification/evidence hooks. | passing (local) |
| F91-05 | concurrency | Purpose/context labels. | passing (local) |
| F91-06 | fixture | Party and non-Party Subject attachment. | passing (local) |
| F91-07 | integration | Notifications #50 consumes the substrate without owning it. | **planned** |
| F91-08 | compile | No provider-specific transport/runtime mechanics become foundation semantics. | passing (local) |

F91-07 is deferred rather than claimed. Notifications owns `NotificationEndpointLink` over `delivery.DeliveryDestination`; moving it onto this substrate changes that package's contract digest and re-opens its own acceptance, so it is a separate change against #50. The consumer fixture's `OutboundRoute` demonstrates the consuming shape — a reference and nothing else — but a probe is not adoption, and this criterion retains its non-passing status until #50 actually moves.

## Executable verification

`node scripts/verify-foundation.mjs --package reachability --suite local` rebuilds both
the package and its typed consumer fixture twice, checks deterministic artifacts,
and runs the generated-bundle tests. `contract.json` links every criterion to its
source test files. Fixtures are synthetic; no adoption in an external production
application is implied. Live D1/PostgreSQL/DynamoDB certification is separate from
the local memory/SQLite acceptance results and is not claimed.
