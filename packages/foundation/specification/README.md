# Specification (experimental)

The package stores stable Repository identities, append-only SpecificationPin facts
(repository + semantic anchor + complete lowercase Git SHA-1/SHA-256 object ID),
and append-only Realization facts (pin + semantic build hash + manifest digest).
Repository provider locators may change; keys and references remain stable.
Generated CRUD exposes pin/realization creation and reads, with indexed lookup by
specification and revision. Update, delete, restore, and lifecycle operations are
absent. The runtime also rejects mutation operations injected into append-only IR.

`resolveSpecificationSelector` and `resolveSpecificationSourceSpan` in
`@forgegraph/runtime` accept a declared `SpecificationProvider`. Selectors are
transient inputs; resolution copies only immutable identity. Source maps use the
compiler's `forge-source-map/1` anchors and must name the exact pinned repository
and revision. A moved file changes a span, not the semantic anchor. Providers are
trusted to retrieve authentic source maps; these checks do not authenticate Git
servers or sign maps. Provider credentials belong to host configuration.

`GitSpecificationProvider` from `@forgegraph/runtime/git-specification` resolves
selectors in configured local Git repositories without a shell. It reads committed
source maps, checks every source digest and byte length against the exact tree,
validates spans, and reads `forge.lock` at the pinned commit. The sidecar may omit
`revision` when stored in that same tree (avoiding a self-referential commit hash);
if present it must match. Repository fetching and Git trust/authentication belong
to the host. This does not claim signed provenance from issue #20.

Run `node scripts/verify-foundation.mjs --suite local --package specification`.
All seven acceptance criteria have executable evidence in `contract.json`, including
real Git evolution/file movement and seven typed deployment, generation, session,
evaluation, manufacturing and lab consumers on memory and SQLite. These are synthetic
fixtures, not claims of adoption in external production repositories.

Manifest digests use `sha256:<64 lowercase hex>`; build hashes remain 64 hex digits
and Git object IDs remain 40/64 hex digits. ArtifactRevision optionally references a
Realization and enforces its source pin and manifest digest. Existing experimental
raw manifest hashes require a data migration that prefixes `sha256:` before upgrade;
compatibility detects the changed wire constraints.

`@appendOnly` is an application-operation invariant. Direct adapter/admin migration
access remains a trusted boundary. Corrections create new facts. Removing the
annotation triggers a compatibility migration finding. Blob mutation, lifecycle,
hierarchy and soft deletion cannot be combined with this annotation.
