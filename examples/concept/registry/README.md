# Permanent semantic registry identities

`registry.entries` uses `authority#stableId` keys. Authorities are exact, case-sensitive
namespaces (normally HTTPS URLs or URNs); stable IDs use URI unreserved characters.
Neither file paths, display names, package releases nor artifact locators allocate identities.
`registry.bindings` explicitly maps local ConceptIR declaration anchors to those identities.
Unregistered declarations retain the existing anchor-based behavior.

Each entry has an exact authority-issued `revision` and a lowercase SHA-256 `digest` of
its definition. `registry_definition_digest` computes the digest with permanent typed
reference identities, the declaration family, and without its presentation name. Package
versions are not revisions. Imports must match both revision and digest; aliases cannot
silently resolve imports. Registration is an authored contract, not a network lookup or
proof of authority ownership. Applications authenticate registry publishers separately.

Moving a declaration requires updating its binding and local references, preserving the
entry. Changing only its name or registry label is a presentation rename. Creating a new
meaning requires a new stable ID. Updating a definition requires a new revision/digest.
Keep previous identities as deprecated entries and record their IDs in the replacement's
`supersedes`. Unknown or cyclic supersession, ambiguous aliases (including collisions with
permanent IDs), conflicting external-standard mappings, and mismatched definitions fail
validation. Labels need not be unique. Aliases and standard mappings are exact strings;
they assert an authored association, not external standards certification.

`forgec concept diff` aligns registered declarations and typed references using permanent
identity, so a source move does not appear as deletion plus addition. Registry metadata
changes remain visible, including labels, deprecation and revisions. Local binding paths
are omitted from this semantic diff. Content hashes still describe the complete document.
Only explicitly registered references have move-independent identity; register dependencies
as well when their moves must preserve a definition's digest.

Two implementations may reference one identity and exact revision with independent L1
artifact locators. `realizations.json` demonstrates this. The following validates their
references; it does not assert that either artifact implements the semantic contract:

```
forgec concept check examples/concept/registry/support.json --closed
forgec concept check-registry-realizations examples/concept/registry/support.json examples/concept/registry/realizations.json
```

Existing compiler projections do not invent registrations. Authors attach registry bindings
to explicit ConceptIR contracts. Source maps and specification source pins remain separate.
