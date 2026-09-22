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

Run `node scripts/verify-foundation.mjs --suite local --package specification`.
Tests exercise malformed revisions, duplicate pins, edits/deletion, realizations,
selector evolution, moved files, and mismatched provider responses on memory and
SQLite plus a mock source provider. Live Git provider adapters, source-map digest
verification, artifact-package links, and the full cross-domain fixture matrix
remain outstanding; contract acceptance entries remain planned.

`@appendOnly` is an application-operation invariant. Direct adapter/admin migration
access remains a trusted boundary. Corrections create new facts. Removing the
annotation triggers a compatibility migration finding. Blob mutation, lifecycle,
hierarchy and soft deletion cannot be combined with this annotation.
