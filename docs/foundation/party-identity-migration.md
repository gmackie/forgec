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

## Read-only export audit

Run `node scripts/audit-foundation-migration.mjs migration-export.json` before
storage migration review. The command never connects to a database or writes rows.
Its JSON report binds to the input SHA-256, exits nonzero on structural problems,
and reports `ready-for-review` rather than permission to deploy.

The version-1 export contains these required arrays:

- `legacyParticipants`: legacy rows with explicit `tenant` and `id`.
- `parties`: proposed Party rows with explicit `tenant` and `id`.
- `mapping`: `{tenant, participant, party}` entries mapping every old identity.
- `before.participations` and `after.participations`: complete membership records.
- `before.ends` and `after.ends`: complete ParticipationEnd records.
- `legacyEvaluationStarts`: legacy starts with `tenant`, `id` and `run`.

Use the same field representation in both snapshots. The only allowed historical
membership difference is `participant`, resolved through the explicit same-tenant
mapping. Membership IDs, timestamps, intervals, roles and all other exported fields
must remain identical. End facts must remain identical, including effective times,
revocation flags and membership references. The audit rejects missing history,
dangling ends, duplicate memberships, duplicate terminals, cross-tenant identity
references and many-to-one identity merges. Intentional identity consolidation
requires a separate reviewed migration; it is not an implicit rename.

An export cannot prove its own completeness. Compare row counts and source hashes
against a quiesced database, preserve the original export, and validate generated
storage constraints in an isolated restored database before cutover. Consumer
satellites and principal representation/revocation records require their own explicit
mapping review. This audit does not create representations or authorization grants.

## Legacy EvaluationStart chronology

The former EvaluationStart schema did not own a server `createdAt`. Neither caller
`startedAt` nor a migration-time backfill proves that a Publication candidate binding
or Knowledge feedback binding preceded execution. Every legacy start in the audit
is therefore marked `reevaluate`, even if an exported `createdAt` looks plausible.

Retain legacy runs and finishes for historical inspection. Exclude their results from
new publication and knowledge authority decisions. Create a fresh binding and a new
run/start under the timestamp-owning schema, execute the evaluation, and publish a
new finish/evidence record. Do not edit append-only historical facts or copy a finish
onto the new run. A restored legacy database must enforce this quarantine before
accepting business traffic; the audit is a review tool, not that enforcement mechanism.

Fresh server timestamps also require strict ordering: equal-millisecond or missing
binding/start timestamps fail closed and require a new, unambiguous evaluation.

## Composed Agreement acceptance storage

Delayed quotation recovery adds AgreementAcceptance and AgreementAcceptanceCommit,
plus nullable references on Agreement and QuoteEnd. Regenerate storage migrations
for the full deployed dependency closure before switching runtime helpers. Preserve
ordinary Agreements with a null acceptance reference; they retain their original
acceptance semantics. Do not infer committed intent for an old Accepted QuoteEnd:
its timestamp alone lacks the new exact-command and signer-window proof. Such a
pending quote requires operator resolution or a new valid acceptance, not synthesized
acceptance/commit rows. The export audit above is scoped to Party and Evaluation;
it does not validate or execute this separate storage migration.
