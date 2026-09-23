# Artifact (experimental)

Artifact is a stable logical identity. ArtifactRevision is append-only, referring to
one write-once ArtifactContent blob and optionally an exact SpecificationPin. Its
schema checks the digest, media type and integer byte count against sealed content.
`Artifacts.publish` accepts an expected SHA-256 digest and rejects unsealed content
or a mismatch; `Artifacts.download` authorizes both revision and content and applies
content-inspection policy before returning a signed URL. Package resources have no
generated HTTP routes; applications bind their authenticated business entrypoints.

`@writeOnce` permits upload attempts until a successful seal, then prevents new
uploads. It removes ordinary update/delete operations entirely. Sealing hashes the
immutable copy, checks byte count again and uses an isolated private key for each
contender. Published bytes therefore cannot be changed through upload races, blob
metadata updates or deletion. Empty content is supported in this profile. Changes
to the annotation produce a compatibility migration finding.

Versioned sealed-object tokens require upgrading runtime readers before writers;
legacy generation-only keys remain readable. Failed sealing/metadata commits may
leave private orphan objects. Provider lifecycle cleanup must preserve referenced
sealed objects. Direct storage and administrative migrations remain trusted boundaries.

Run `node scripts/verify-foundation.mjs --suite local --package artifact`.
Tests compile real specification dependencies and synthetic build-output, evidence,
generated-asset and document consumers; memory/SQLite tests exercise verified
publication, replay, empty content, immutable revisions/content, inspection and
access denial. Blob tests cover staging replacement and concurrent finalizers.

ArtifactRevision optionally pins an immutable ArtifactComponent chain. Components
reference exact child revisions and the next component; build the chain before
publication, then atomically create the revision with its head. Extending a chain
creates a different head and cannot change published membership. Traversal rejects
cycles, duplicate names and more than 128 components, and authorizes child reads.
Reference guards plus append-only records prevent application-created cycles.
Optional Realization links enforce matching specification pins and SHA-256 manifest
digests in schema rules, including direct revision creation.

All seven issue acceptance criteria have local executable evidence in `contract.json`.
Provider relocation workflows and hosted R2/S3 certification are separate deployment
concerns; signed attestations belong to the source-map/signing workstream. No production
domain adoption or hosted certification is claimed by the synthetic consumer tests.
