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

Limits: 1,024 changes, 32 MiB changed bytes; at most 1,024 base tree entries,
32 MiB base metadata and 64 tree levels; at most 2,048 prepared tree entries.
The pack store admits 4,096 objects, 32 MiB uncompressed bytes and 30 MiB per
object. Exceeding a limit fails explicitly. Untouched symlink/gitlink entries
are preserved; creating either remains unsupported. No merge or checkout API is
provided by the Workers class; those operations retain the Node path.

This is the preparation slice of FORG-19, not live Artifacts publication. The
Artifacts binding documentation checked on 2026-10-15 exposes read and management
methods, but no object-write method. A future transport must read base objects,
send the pack over authenticated Git receive-pack under the publication journal's
exact expected-ref guard, and reconcile uncertain responses before finalizing a
D1 receipt. Supplying a store does not authorize publication. No production
binding, credential, ref, gateway backend or migration authority changes here.
