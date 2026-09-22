# Semantic source maps, version 1

`forgec build` emits `source-map.json` beside `app.json`. The sidecar is operator metadata and does not participate in DomainIR, contract digests, or build identity. It contains no source text. Set `FORGE_SOURCE_REVISION` to record the repository revision.

The root contains `version: "forge-source-map/1"`, `package`, `buildHash` (the exact bundle hash), `compilerVersion`, optional `revision`, and three dictionaries:

- `sources`: package-relative paths to `{digest: "sha256:<hex>", byteLength}` for original UTF-8 bytes.
- `anchors`: semantic identifiers to `{file, start, end}`. Ranges are half-open UTF-8 byte offsets, not UTF-16 positions.
- `derivations`: semantic identifiers to arrays of `{kind, from}` edges. `from` is another semantic identifier; dependency origins may require the dependency's separately verified source map.

## Anchor encoding

Declarations use their qualified IR identifier, for example `@app/domain/_/Order`. Named child constructs append `#kind:name`. Nested constructs append `/kind:name`, for example `Order#lifecycle:status/transition:finish/field:note`. Anonymous constructs use a SHA-256 digest of their non-trivia token texts separated by NUL. Whitespace, comments, and file paths do not enter that digest. Anonymous constructs change identity when their tokens change; identical repeated constructs within the same scope resolve to the first occurrence.

Supported child kinds are `field`, `decorator`, `rule`, `unique`, `find`, `list`, `lifecycle`, `transition`, `capability`, `capability-atom`, `purpose`, `uses`, `message`, `step`, `schedule`, `aggregate`, and `target`. Fields, transitions, lifecycle blocks, capabilities, messages and steps use names. Other children use token digests, including decorators so different applications do not collide. Subscriptions use `<package>/<module>/#subscription:<token-digest>`.

Resource operations use `<resource>#op:<operation-suffix>`, with a `generated-operation` edge to the resource declaration. Facet-expanded fields use the consuming resource's field anchor and have `facet-field` and `facet-application` edges to the template field and application. Application anchors use `<resource>#facet:<qualified-facet-id>`.

Future language constructs can add kinds such as `expose`, `binding`, `handler`, `alarm`, `execute`, `requirement`, and `search`. Source blocks currently support schedules and function targets; HTTP exposure blocks are not yet accepted by the parser. Physical SQL/SDK output maps and complete lowering provenance are outside this initial implementation.

## Resolution and trust

Registry publication accepts an optional `sourceMap` alongside the bundle. It becomes a separate `source-map/1` content-addressed layer covered by the manifest signature. Pull verifies layer digests and signatures before validating the map's package, build hash, optional revision, path safety and byte ranges. Source maps grant no runtime authority.

The registry exports `sourceFor(map, subject)` for exact anchors and compatibility subjects such as `Resource.field`. Before opening a checked-out file, use `verifySourceBytes(map, path, bytes)` to reject stale source. A valid signature verifies the publisher, not the truth of a claimed source location.

Operation telemetry includes `buildHash` and, for resource operations and functions, `semanticAnchor`. The runtime does not load the sidecar. These fields do not become metric dimensions. Operators resolve them against the verified artifact; caller-facing responses need not disclose source paths.
