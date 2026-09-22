# Explicit local package assembly

Path dependencies remain contract-only by default. A deployment opts into ownership:

```toml
[dependencies]
records = { path = "../records", deploy = true }
payments = { path = "../payments" }
```

Every package is compiled separately against its direct dependencies' exported contracts.
Assembly runs afterwards, collecting the root and recursively selected `deploy = true`
edges. A remote edge does not select its target or that target's deployment subtree.
Importing a contract never creates a table by itself, and assembly does not grant access
to private or transitive declarations during compilation.

The selected packages share one runtime model and store transaction domain. Declaration,
resource, field-reference and operation identities retain their original package IDs.
Module containers are qualified as `<package>/<module>` in assembled IR because module
names are otherwise package-local. Diamonds deduplicate by package identity; differing
versions or compiled contracts under one identity fail closed. Package order and source
paths do not affect output. Cyclic path dependencies fail before compilation.

The root remains the deployment's package/profile/observability configuration. Selected
packages must use the same profile. The root must explicitly select targets if a
selected package constrains its targets, and every selected target must be supported.
An empty dependency target list imposes no additional target restriction. Dependency
observability defaults do not override the application-wide root configuration. All required IR features are retained. The bundle's
`deployment` object (`package-assembly/1`) records package metadata and package-local
imports, without flattening aliases from different scopes. It is omitted for ordinary
contract-only applications. Locks pin every transitive dependency and the selected
deployment identities; the build hash includes the selected package contracts.

Owned resource references, resource uses/transitions and view/projection sources must
resolve inside the assembled model. They are not remote foreign keys. Planners emit
the complete closure, including tenant-scoped foreign keys. Compatibility and migration
commands consume these assembled bundles normally. No table renaming is introduced:
physical table/index, resource/wire/function names and resource/function HTTP routes
that collide are rejected. Packages must currently choose distinct names.

Runtime implementations must still be registered for every owned callable. Assembly
does not synthesize function bodies or change `external` dispatch into a local call.
An explicitly supplied external binding remains outside the local atomic commit; this
feature makes no distributed transaction guarantee. Extension manifests are verified
throughout the dependency graph, but assembled deployments with extensions are rejected
until extension pins can be represented in the assembled build/lock contract. Facets, patterns, source-map
artifacts and nested atomic function dispatch are separate features.

Verification: `cargo test -p forgegraph-cli --test composition --locked` exercises actual
manifest loading, compilation, planning, clients, SQL, deterministic diamonds, remote
defaults, conflicts/cycles and stale locks. Runtime/provider behavior needs the separate
generated-bundle conformance suite; compiler tests do not certify a provider.
