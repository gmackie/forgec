# Qualification substrate contract

Experimental `@forgegraph/foundation/qualification` 0.1.0, issue #56.
Direct co-deployed dependencies: Party, Specification and Evidence. No system imports.

The implemented graph owns pinned definitions, domain-specific ordered levels,
typed subject handles, awards, requirements and revocation. PartySubject is the
explicit business-actor mapping; machines use typed consumer satellites.
Qualification is not an authorization capability. Exact definition IDs delimit
level comparison; requirements never silently float to new authored revisions.

Evidence hooks pin EvidenceSeal rather than an open bundle. Typed credential or
attestation details can reference the award from the producing domain. Actual
Assurance/Evaluation producer adapters remain upper-layer work. Award validity is
[issuedAt, expiresAt), further bounded by a unique revocation fact. Corrections and
renewals create new awards; old facts remain immutable.

## Acceptance

F56-01, F56-02, F56-03, F56-04 and F56-06 have local generated memory/SQLite evidence
in `packages/runtime/test/foundation-qualification.test.ts`. F56-04 covers the sealed
evidence reference and typed satellite hook, not a completed Assurance integration.
**F56-05 Routing integration remains planned** until actual Routing consumes and
revalidates these facts. `contract.json` records this distinction; the package is
not fully complete against issue #56 while that criterion remains planned.

Tests cover all three typed consumer subjects, level and revision mismatch,
duplicate awards/revocations, half-open validity, historical lookups, explicit
expiration, full-page traversal, unreadable support/revocation, and authority/tenant
separation. Provider certification and production adoption are not claimed.

Reproduce after building the consumer with the current compiler:

```sh
target/debug/forgec build packages/foundation/qualification/fixtures/consumer --out /tmp/foundation-qualification-consumer
FORGE_FOUNDATION_CONSUMER=/tmp/foundation-qualification-consumer pnpm --filter @forgegraph/runtime exec vitest run test/foundation-qualification.test.ts
```

See README.md for lookup budgets, vocabulary ownership and Routing concurrency limits.
