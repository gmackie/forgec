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

Manifest/component assembly and atomic publication of its frozen membership,
relocation workflows, live R2/S3 certification and production domain adoption are
outstanding. Acceptance entries remain planned; this slice does not claim a complete
artifact package or provider certification. Signed content attestations are not part
of the current provenance checks.
