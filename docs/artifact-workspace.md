# Prepared artifact workspaces

`@forgegraph/runtime/artifact-workspace-git` exposes a Node-only
`GitArtifactWorkspace` over a dedicated bare Git object database. It prepares
immutable revisions without changing refs or touching a working tree. Supply a
trusted tenant/artifact/generation/repository identity and an authorization
callback, then pass prepared pins to the separate journaled publisher.

- `prepare({base, changes, message, at}, context)` applies a bounded set of file
  replacements/deletions to an exact base pin (`null` creates a root). Bytes are
  copied before authorization. Regular and executable modes are supported. The
  message, timestamp, base and bytes determine the commit; retrying the same
  preparation produces the same OID.
- `diff(left, right, context, {maxEntries})` returns exact before/after blob IDs,
  modes and paths. Rename detection is disabled, so renames appear as delete/add.
  Exhausted budgets fail rather than returning a truncated diff.
- `merge({base, left, right, message, at}, context)` requires the sole Git merge
  base to equal the supplied base. A clean result is a prepared commit preserving
  both distinct ordered parents (identical heads are rejected); conflicts return explicit paths and never publish a ref.

These operations reauthorize each request and reject foreign tenant/artifact,
changed generation/repository/format, or substituted trees. The local directory
and its Git configuration are trusted composition-root inputs. All referenced
objects must already be available locally. This class does not mint credentials,
fetch remote objects, allocate provider forks, or grant a lease to publish.
Authorization currently operates at artifact scope; paths are not per-file ACLs.

The bound repository ID is the configured remote identity carried into prepared
pins, not a filesystem identifier. Publication must independently recheck remote
identity. A local object database can be discarded only after its unreferenced
prepared commits are retained or remotely accepted. This API writes no retention
refs, so hosts must keep objects safe from garbage collection until then.

Limits: 1,024 changes, 32 MiB changed bytes, 1,024 diff/conflict paths, bounded
subprocess output, and 30-second Git command timeouts. Changes reject traversal,
control characters, backslashes and `.git` path components. New symlinks and
submodules are unsupported; unchanged base entries retain Git's existing modes.
There is no arbitrary merge-driver sandbox here.
Git and dedicated repository configuration must remain trusted.

Real Git tests cover deterministic pins, binary bytes, executable modes,
deletions, unchanged refs, ancestry-preserving merges, explicit conflicts,
incorrect merge bases, caller mutation, authorization and budgets. This is local
object preparation; the live Artifacts publication evidence remains separate.

## Isolated materialization

`materialize(pin, destination, context, {maxFiles, maxBytes})` creates a new
absolute destination exclusively and writes the exact pinned tree. The host owns
the destination's parent directory and must prevent other processes from replacing
paths during the operation. It must not expose the directory until success. An
existing directory or symlink is never overwritten or removed. On a caught write
failure, only the newly created directory is removed; abrupt host loss may leave
an incomplete directory which must not be activated.

Authorization runs with action `materialize`; generation, repository identity,
commit and tree are checked again. Limits default to 1,024 files and 32 MiB total,
with 8 MiB per file. All blobs are read and validated before directory creation.
Regular/executable files preserve bytes and executable mode. Git hooks, checkout
filters and working-tree configuration are not used. Symlinks, gitlinks,
non-UTF-8/unsafe paths and LFS pointers fail explicitly. Filesystem name collisions
fail the operation and remove the incomplete output. This writes no `.git`
metadata and does not grant a task lease or provision a remote fork.

## Workers-compatible object preparation

`@forgegraph/runtime/artifact-workspace-workers` exposes
`WorkerArtifactWorkspace.prepare` with the same explicit base, file changes,
message, timestamp and authorization contract as the Node preparer. It uses Web
Crypto and byte arrays; it imports no Node APIs and never updates a ref. Its
SHA-1 pins match Git and the existing Node preparer, including binary bytes,
executable modes and Git's bytewise tree ordering. SHA-1 here identifies Git
objects; it is not an authentication or evidence-signing mechanism.

Supply a server-selected `WorkerGitObjectStore`. Reads return raw immutable Git
objects, whose content hashes are checked before use. Writes store immutable
objects and must return their exact content ID. Tenant, generation, repository,
base tree, authorization and budgets are checked independently of that store.
Inputs are copied before asynchronous authorization. Failed preparation never
returns a successful pin, though already stored unreachable objects can remain.
The store must retain these objects until publication or explicit expiry.

`WorkerGitPackStore` is a request-local implementation which optionally delegates
base reads to a trusted object reader. `pack()` produces a bounded v2 non-delta
Git pack using `CompressionStream("deflate")`. Native `git index-pack --strict`
tests verify these packs. The pack contains prepared objects; unchanged base
objects must already exist at the destination. Retries deduplicate identical
objects. This store is ephemeral: hosts must persist a prepared pack or regenerate
it from its exact input before acknowledging durable preparation.

Preparation is incremental (FORG-22). It reads the base commit and only the
trees on changed paths; untouched subtrees keep their IDs and are not re-encoded,
so the pack holds only new objects. A one-file change to a 1,600-file base reads
three objects and packs four. `author` sets author and committer (default
`Forge artifact <artifact@forge.invalid>`); names and emails may not contain
`<`, `>`, control characters or surrounding spaces.

Limits: 1,024 changes, 32 MiB changed bytes; at most 1,024 tree entries read,
32 MiB base metadata and 64 tree levels; at most 2,048 prepared tree entries.
Read limits count only the trees a request loads, not the size of the base.
The pack store admits 4,096 objects, 32 MiB uncompressed bytes and 30 MiB per
object. Exceeding a limit fails explicitly. Untouched symlink/gitlink entries
are preserved; creating either remains unsupported. Checkout remains Node-only.

### Merge and diff in Workers

`merge({ base, left, right, message, at, author? })` returns the same
`prepared`/`conflicted` result as the Node workspace. It first confirms that
`base` is the unique best common ancestor of both parents, walking at most
4,096 commits newest first, and fails with `VersionConflict` otherwise. The
merge is tree-level: a path both sides changed differently is a conflict, as is
a file on one side replaced by a directory on the other. Unlike
`git merge-tree`, non-overlapping edits inside one file are **not** combined;
callers resolve such files and prepare again. Clean merges produce the same
commit as the Node path. The merge commit's parents are `[left, right]`.

`diff(left, right, { maxEntries? })` matches the Node `diff` (Git `diff-tree -r`
order, statuses, modes) and skips subtrees whose IDs are equal.

### Base objects from the Artifacts binding

`cloudflareArtifactsObjectSource(repo)` (in `cloudflare-artifacts`) reads base
objects through an open repo handle's `readCommit`, `readTree` and `readBlob`.
Wrap it in `WorkerGitPackStore` so prepared objects stay local:

```ts
using repo = await env.ARTIFACTS.get(name);
const store = new WorkerGitPackStore(cloudflareArtifactsObjectSource(repo));
const workspace = new WorkerArtifactWorkspace(binding, store, authorize);
```

The binding returns parsed commits without timezones, so commit bytes cannot be
rebuilt. Stores may therefore implement `readCommit(oid)` (tree, parents,
committer time), and the workspace trusts the binding for its own commit IDs.
Trees are re-encoded from their entries and blobs read raw; both are still
checked against their IDs. Live evidence:
`docs/evidence/forg22-incremental-live-2026-10-15.json` (disposable repository:
base, incremental session commit of four objects, guarded head move, Worker
merge landed with compare-and-swap, stale head rejected, same-path conflict,
diff, binding read-back, deletion).

This is the preparation slice of FORG-19, not live Artifacts publication. The
Artifacts binding documentation checked on 2026-10-15 exposes read and management
methods, but no object-write method. A future transport must read base objects,
send the pack over authenticated Git receive-pack under the publication journal's
exact expected-ref guard, and reconcile uncertain responses before finalizing a
D1 receipt. Supplying a store does not authorize publication. No production
binding, credential, ref, gateway backend or migration authority changes here.
