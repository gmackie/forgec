# @forge/registry

Immutable contract distribution without a request-time hot path (M15).

| entry | what |
|---|---|
| `artifacts` | `Registry` over an `ArtifactStore` (`MemoryArtifactStore`, `FileArtifactStore` = OCI-like `blobs/sha256/*`, `signatures/*`, `tags/*`). `publish` stores allow-listed layers (bundle, ir, contracts, openapi) + a signed manifest; `pull` re-verifies digests, Ed25519 signature (authority-bound), and IR schema; `pullLocked` resolves by digest only; path dependencies bypass the registry. |
| `catalog` | `Catalog`: derived index (exports, fields with classes/subjects, purposes/surfaces/capabilities, actions, effects, owners, dependencies). `index` is idempotent per digest; `rebuild(registry)` re-derives from artifacts. Reads: `packages`, `search`, `graph`, `actions`, `fields`, `effects`, all filtered by `AccessPolicy`. |
| `security` | `AccessPolicy` (namespace globs + audiences; `explain` names the reason without the hidden data), `qualifiedId(authority, name, version)`, authority-keyed grants. |
| `deployments` | `Inventory`: signed release reports vs observations; staleness; retirement; `checkEndpoint` (no private/metadata/literal-IP hosts, allow-list); `bindingFor` issues an `httpCallable` only for a fresh signed report whose digests match. |
| `snapshots` | `SnapshotPublisher` (full/incremental, signed, expiring) and `SnapshotHolder` (verify, chain by epoch, ack). `withSnapshotAuthority(authorizer, holder, clock)` bounds an `Authorizer` by the snapshot: valid → decide; grace → decide (annotated); `deny` → deny after grace; `degrade-readonly` → reads only for `maxDegradedMs`, then deny. The epoch rises past expiry so cached allows die. |

Tests: `test/*.test.ts` cover PAR-124..131.
