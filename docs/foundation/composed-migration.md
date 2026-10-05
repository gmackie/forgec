# Composed legacy Foundation migration

`scripts/foundation-migration-compose.mjs` prepares one tenant's canonical export
for an isolated, fenced import rehearsal. It combines explicit Participant-to-Party
mapping, legacy Agreement storage treatment, and Evaluation quarantine. It never
connects to a database, creates a principal representation, fabricates acceptance
proof, or authorizes production cutover.

```sh
node scripts/foundation-migration-compose.mjs \
  source-export.json source-app.json target-app.json review.json candidate.json
```

The output file is created exclusively with mode0600. It contains `{snapshot,
report}`; pass **the `snapshot` member** to administrative import/verify. A blocked
legacy Accepted quote produces a report and `snapshot: null`, with exit status 1.
Malformed inputs fail without producing a candidate. Preserve the source export,
both compiled bundles, review manifest and report independently of the candidate.

## Review manifest

The manifest is explicit input, not an automatically inferred approval. Digests use
the exported `migrationDigest(value)` function: SHA-256 of canonical JSON with
sorted object keys and preserved array order. `sourceDigest` binds the complete
canonical snapshot; bundle digests bind actual bundle content as well as its
declared build hash. The compiler's build hash is not recomputed by this tool.

```json
{
  "version": 1,
  "tenant": "tenant-id",
  "sourceDigest": "<migrationDigest(source-export)>",
  "sourceBundleDigest": "<migrationDigest(source-app)>",
  "targetBundleDigest": "<migrationDigest(target-app)>",
  "sourceBuildHash": "<source-app.buildHash>",
  "targetBuildHash": "<target-app.buildHash>",
  "reviewedBy": "migration-operator",
  "recordedAt": "2026-09-23T00:00:00Z",
  "legacyAcceptedQuotes": "block",
  "ordinaryAgreements": "preserve-without-acceptance",
  "emptyTargetResources": [
    "@forgegraph/foundation/agreement-catalog/_/AgreementAcceptance",
    "@forgegraph/foundation/agreement-catalog/_/AgreementAcceptanceCommit"
  ],
  "identity": {
    "mapping": [{"tenant": "tenant-id", "participant": "old-id", "party": "new-id"}],
    "parties": [{
      "tenant": "tenant-id", "id": "new-id", "label": "Reviewed identity",
      "identifiers": null,
      "createdAt": "2026-09-23T00:00:00.000Z",
      "updatedAt": "2026-09-23T00:00:00.000Z"
    }],
    "referenceFields": [{
      "resource": "@forgegraph/foundation/participation/_/Participation",
      "field": "participant"
    }]
  }
}
```

Enumerate **every** source field typed as Participant in retained resources, including
consumer satellites, Agreement supplier/customer fields and other application
references. The tool derives this set from the source bundle, requires an exact
review list, checks the corresponding target field is Party with otherwise
unchanged type, and rewrites only those fields. Strings that happen to contain
identity IDs are not rewritten. Their application meaning requires separate review.

Supply one proposed Party per legacy Participant, with a one-to-one same-tenant
mapping. Existing retained Parties cannot be reused as mapping targets. Identity
merges and automatic identity reconciliation are deliberately unsupported. Party
labels, optional identifier references and timestamps must be explicitly supplied;
the tool does not derive them from principal or organization data. An existing
identifier reference must resolve in the target snapshot.

`emptyTargetResources` must list exactly every new target resource except Party
and EvaluationQuarantine, including new PrincipalRepresentation and
RepresentationRevocation resources if present. They remain empty. Nonempty removed
resources, including PrincipalParticipant or OrganizationParticipant, block this
profile: their facts need a separate reviewed migration rather than being silently
discarded or converted into authorization. Retained representation/revocation
records remain unchanged except any explicitly typed Participant-to-Party reference.

## Preserved history and unsupported changes

The source manifest must match every resource declared by the source bundle, with
matching resource counts, hashes and unique record IDs. This detects omitted
resource sections; it does **not** prove that an export contains every source row.
The existing Party audit checks complete membership/end provenance and rejects
identity merges, dangling ends and altered history. Membership IDs, intervals,
roles, reasons, revocation times and other fields are retained.

Ordinary Agreements acquire only the new nullable `acceptance: null` field. No
AgreementAcceptance or AgreementAcceptanceCommit rows are synthesized. This
legacy profile rejects existing proof rows and nonnull acceptance references;
mixed current/legacy proof migrations require a separate profile. Nonaccepted
QuoteEnd history acquires nullable intent/digest fields where newly declared.
Every legacy Accepted QuoteEnd is explicitly unresolved and blocks the entire
candidate, including an accepted quote with an already issued agreement. Retain
its source history and resolve the compatibility treatment separately; never
change its historical outcome merely to make this tool pass.

The composer invokes `prepareEvaluationMigration` after identity mapping. Every
started legacy run receives quarantine even if its timestamps look plausible.
New quarantine provenance binds the **original** source snapshot; the report also
retains the intermediate preparation digest. Legitimate Cancelled finishes with
no start remain historical cancellations and do not receive a fabricated start.

Only Participant reference changes, EvaluationStart storage timestamp additions,
and the enumerated nullable Agreement/QuoteEnd additions are supported field
changes. Other retained field removals/type changes or added fields block. Target
required fields and references are checked. This is not a general evaluator of
all target row rules, scalar constraints, unique indexes or storage migrations:
review bundle semantic changes and rehearse against actual generated storage.

## Rehearsal and cutover boundary

1. Fence and drain the source; independently reconcile row counts and export hashes
   against that source. Preserve the original export and provenance.
2. Review the explicit mapping, all typed satellites, representation/revocation
   treatment, and source/target schema changes. Create the bound manifest.
3. Prepare the candidate. Any unresolved report has no importable snapshot.
4. Apply reviewed target DDL to an isolated empty database and fence the target.
   Import the candidate snapshot, then verify exact counts, hashes and references.
5. Exercise historical membership/end reads, revoked authorization behavior,
   quarantine rejection and fresh evaluation, plus ordinary Agreement behavior.
   Resolve any target constraint or semantic incompatibility before cutover.
6. Keep the target fenced until deployment-specific review and verification are
   complete. Production cutover and rollout remain separate actions.

Import is resumable, not one cross-resource atomic transaction. Quarantine is a
fenced migration mechanism, not concurrent revocation of already admitted work.
Neither a prepared report nor a passing synthetic fixture closes the production
migration gate in issue #71.
