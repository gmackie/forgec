# Party replaces participation-owned actor identity

The experimental Participation package now imports Party with `deploy = true`.
`Participation.participant` retains its field name but references
`@forgegraph/foundation/party/_/Party`. ParticipationSet, roles, membership validity,
end/revoke facts, uniqueness and historical lookup behavior are unchanged. The
`Participations` TypeScript API still accepts and returns `participant`, now a Party ID.

The old `participation.Participant`, `PrincipalParticipant` and
`OrganizationParticipant` fixture resources are removed. Party owns business identity
and append-only PrincipalRepresentation/RepresentationRevocation facts. Person and
Organization detail remains typed domain data. The Participation consumer contains
an OrganizationParty satellite and reads Party representation in its PIP, including
revocation, pagination and tenant isolation. Neither representation nor membership
is an authorization grant.

This is an experimental schema-breaking identity correction, not a silent compatible
rename or an executed production data migration. Existing deployed consumers must
retain an explicit old-Participant-to-new-Party mapping and migrate typed membership
references and terminal history together under a reviewed migration. Do not simply
reinterpret old IDs, recreate memberships without their end facts, or fabricate an
authorization grant from a Principal mapping. Build/compatibility and storage migration
review are required before deploying over an existing schema. No production migration
is performed here.

Integrator-owned follow-up: regenerate Party/Participation package and consumer
fixtures, update shared catalogs/evidence and verifier registration, and expose the
Party runtime wrapper alongside existing Foundation exports. Entitlement consumes
Party directly; it must not obtain business identity indirectly from membership.
