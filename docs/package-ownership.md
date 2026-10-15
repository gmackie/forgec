# Package ownership

`package-identities.json` is the canonical public SDK identity map for
`gmackie/forge`. All nine currently published names remain unchanged, including
`@forgegraph/registry` and its subpaths. It is the artifact/catalog/grants SDK,
not an npm registry server. Existing consumers need no import migration.

ForgeGraph's `apps/registry` is a separate private Verdaccio service. Its intended
identity is `@forgegraph/registry-service` (FORGE-117); the service rename and Nix
selector updates are in [ForgeGraph PR823](https://git.forgegraf.com/gmackie/ForgeGraph/pulls/823). Until that merges, both repositories still contain
the overlapping name. A declaration in this policy alone does not fix that peer.

Run `pnpm release:identities` to reject missing owners, unknown public names,
duplicate workspace identities or repository metadata drift. The guard is offline;
it does not establish permission to publish to npm. The beta release must also
check authenticated registry ownership and exact version availability.

Repository metadata now points at Forgejo. npm GitHub/GitLab provenance is not
requested from Forgejo runners. This does not supply an alternative attestation:
release signature and source-bound certification remain separate required evidence.

The consumer inventory includes the Forge console and conformance suite, both
using the existing registry SDK subpaths; package exports and workspace dependency
names were preserved. Historical changelog references remain valid.
