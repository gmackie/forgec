# Identifiers (experimental)

IdentifierSet is an application-owned typed sidecar. Issuer is an identifier-specific
handle with domain mappings such as HospitalIssuer. Identifier and its optional
IdentifierDisposition are append-only facts. Canonical Forge record IDs remain unchanged.

`Identifiers` from `@forgegraph/runtime` provides assignment, qualified lookup,
revocation, supersession and paged history. The application invokes these operations
behind its authenticated, authorized business surface. There are no generated HTTP
routes for these resources in this package. Normal Engine authorization still applies.

Uniqueness is tenant + normalized namespace + issuerScope + normalized value.
Absent issuer is the explicit `namespace` scope; a present issuer must match its
scope field, enforced by a schema rule and a typed reference guard. Namespace names
are trimmed/lowercased; values are trimmed and case-sensitive in this initial profile.
There is no per-namespace custom normalizer registry yet. Changing normalization
requires an explicit migration; expiry and terminal dispositions never free a claim.

Validity is [validFrom, validUntil). A disposition ends validity at effectiveAt.
A replacement must belong to the same set, start later, and take effect at its start.
Strictly increasing replacement start times prohibit supersession cycles. Disposition
uniqueness makes conflicting revoke/supersede attempts fail atomically. The one terminal
fact retains the reason and replacement; prior-time lookups remain available.

Run `node scripts/verify-foundation.mjs --suite local --package identifiers`.
Tests use generated bundles on memory and SQLite, covering duplicate races, issuer
scopes, normalization, half-open boundaries, preserved claims, supersession/revocation,
idempotent replay, restart and tenant isolation. The consumer fixture compiles GitHub,
serial-number and healthcare-style typed sidecars; it is synthetic, not evidence of
production adoption. Live provider certification and custom namespace policies remain
outstanding. Package acceptance entries remain planned until the full matrix is verified.
