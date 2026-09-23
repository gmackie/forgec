# Participation (experimental)

Participant and ParticipationSet are typed substrate handles. Application resources
own scope through outward references; PrincipalParticipant and OrganizationParticipant
in the consumer fixture provide explicit identity mappings. A participant is not a
universal entity reference or an authorization grant.

ParticipationRole registers an immutable, namespaced vocabulary. The generic
`Participations<Role>` runtime wrapper validates the consuming application's declared
role union at runtime as well as in TypeScript. Role registration is an administrative
operation; domain entrypoints should expose the typed wrapper with normal Engine
policies. There are no generated HTTP routes in this package.

Memberships and terminal ParticipationEnd facts are append-only, tenant-scoped and
timestamped. The wrapper records the acting principal and a reason. Validity is
[validFrom, validUntil); ending or revocation ends it at effectiveAt while preserving
historical lookups. Duplicate set/participant/role/start assignments conflict, as do
concurrent end/revoke attempts. This profile allows different-start overlapping
memberships; stricter per-set overlap policies are not implemented.

`listAt` returns paged facts from the declared vocabulary. Follow `next` even when
`items` is empty: expired, ended or out-of-vocabulary rows may consume a storage page.
It preserves the engine's authorization checks and refuses to treat an unreadable
terminal fact as absent. An application PIP can use the typed PrincipalParticipant
mapping and exhaust these pages under an authorized service context to obtain facts.
The authorizer must independently decide what the facts permit. `participationPipAuthorizer` bridges a live, tenant-scoped fact reader to independent
Gatekeeper policies. It disables allow caching and forces per-record list decisions
so revocation/time boundaries are reread on each decision. The reader supplies fresh
attributes and uses a separate service engine with explicit read policies; failure
propagates rather than granting authority.

Run `node scripts/verify-foundation.mjs --suite local --package participation`.
The verifier builds deterministically, compiles synthetic team/classroom/review-board
and identity-mapping consumers, and tests generated bundles on memory and SQLite.
Tests cover role rejection, validity boundaries, duplicate/end races, immutable
history, tenant isolation and hidden terminal facts. All six issue criteria have local executable evidence in `contract.json`.
The integration test covers explicit principal mapping, paginated fact reads, an
independent policy, immediate revocation and tenant isolation. Hosted provider
certification and stricter overlap policies are separate deployment/extensions.
