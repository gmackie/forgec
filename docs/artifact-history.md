# Verified history archives

`node scripts/artifact-history.mjs export <bare-repo> <new-bundle> <new-manifest>` produces a Git bundle and a SHA-256 inventory. `restore <bundle> <new-directory> <manifest>` reconstructs a new bare repository and verifies every ref, object ID, object type, byte length, raw object digest, and the symbolic default branch. Existing destinations are never overwritten.

The archive contains every ref and its full reachable object graph, including merge parents, executable bits, binary blobs and retained draft branches. It does not contain application databases, publication journals, reflogs, credentials, hooks, repository configuration, LFS payloads or submodule repositories. LFS pointers, submodules, replacement refs, non-HEAD symbolic refs, shallow repositories, and unreferenced commits are rejected. Pin unpublished commits under explicit retention refs before exporting. Budget limits are 4,096 refs, 100,000 objects, 32 MiB per object and 256 MiB of object content.

Use a trusted, dedicated local bare repository. Fence writers during export: the repeated inventory detects changes but is not a distributed lock. Keep the manifest through a trusted channel; its hash detects corruption, not a malicious replacement of both files. The implementation verifies a temporary restore before publishing the bundle. A CLI manifest-write failure may leave a verified bundle, so reserve both output names in advance and inspect any reported failure.

For rollback, fence new writes first and archive the **current** history, including commits made since cutover. Restore that archive to a new destination and compare it with the manifest before changing routing. Restoring only the pre-cutover archive loses later writes. Publication journals and pending receipts need separate retention and reconciliation; an observed remote head does not prove acceptance. The real-Git regression rehearses this sequence and verifies the post-cutover commit survives rollback.

This is a local interchange primitive. It does not provision Cloudflare repositories, transfer provider credentials, change application routing, or certify a production migration.

## Preserve the worktree before history interchange

`python3 scripts/vault-snapshot.py <source> <new-private-directory>` makes an
exclusive private copy of all regular files and directories, including ignored
files and `.git`. It preserves file modes and symlink text without following
links. Before/after inventories compare hashes, sizes and modes against the
copy; special files, source changes, existing destinations and destinations
inside the source are rejected. Partial copies remain **unverified** and have
no verified manifest. Default limits are 2 GiB and 100,000 entries; an explicitly
chosen byte budget may be passed with `--max-bytes`.

Treat the snapshot and its manifest as sensitive: they may include credentials,
private filenames, ignored drafts and unreachable Git objects. Keep them in a
private state directory, never a source repository or CI artifact. Work from a
separate derived repository when building migration refs; never normalize or
rewrite the preserved `.git` tree itself.

This is an operator-run rehearsal tool for trusted local trees. It is not a
security boundary against malicious concurrent filesystem changes, a writer
fence, or an atomic filesystem snapshot. ACLs, xattrs and hardlink relationships
are outside its verification scope. Before a production cutover, fence writers
and take a fresh preservation copy using the host's backup requirements.

## Cloud history rehearsal and workspace links

The private-source roundtrip in
`docs/evidence/bob-vault-cloud-roundtrip-2026-10-02.json` verified 215 commits,
14 refs and 1,420 objects through a disposable Cloudflare Artifacts repository.
An additional synthetic commit survived cloud readback, bundle export and local
rollback restore (216 commits). The disposable repository was deleted. This
operator-run rehearsal used Wrangler OAuth and did not change Bob routing,
source refs, source working trees or scheduled credential permissions.

`GitArtifactWorkspace.materialize` still rejects symlinks by default. A trusted
host can opt into `{ symlinks: "internal" }`. This preserves original link text
only when every target resolves through real directories to an existing regular
file or directory in the pinned tree. Absolute paths, root escapes, backslashes,
control characters, invalid UTF-8, `.git`, empty/dot path components, dangling
targets and chained links are rejected. Directory containment plus alias edges
must form an acyclic graph; self-links, ancestor links and mutually recursive
aliases fail before destination creation. Normal files are written before links.
Link target bytes and link entries count against the existing byte/file budgets.
The trusted, exclusively owned destination-parent requirement still applies.

`docs/evidence/bob-vault-symlink-policy-2026-10-02.json` records aggregate inspection
of preserved HEAD trees. Their relative directory links satisfy the policy, but
each source has one absolute link. Whole-tree materialization remains blocked
until that external payload has an explicit disposition; no link is silently
omitted, rewritten or followed by history interchange.

Bob PR #229 adds authenticated, actor-bound application route composition and a
shared process-local close-and-drain host. Its local route qualification does not
establish deployed route behavior, legacy-writer fencing, process-kill recovery
or acceptance of uncertain provider writes. These remain cutover gates alongside
external-link disposition, runner completion wiring and fresh source snapshots.

## Approved external draft import (2026-10-03)

The owner selected importing `Blog Drafts` into the vault as ordinary files.
The website drafts were privately snapshotted and verified before import:
36 files, 210,705 bytes. A new commit replaces the absolute alias in a derived
migration repository; original history and all source snapshots retain it.
No source vault or website file was changed. All 215 prior commits and 14 refs
remain, with the import adding the 216th commit.

Forge's actual materializer accepted this derived head with `symlinks: internal`:
547 entries, 2,402,366 bytes. Every imported draft's SHA-256 matched its private
snapshot. The verified bundle and full filename manifests remain private;
`docs/evidence/bob-vault-drafts-import-2026-10-03.json` contains aggregate evidence.
This resolves the external-link policy for the migration copy. Fresh working-tree
changes and ignored data still need their own disposition before live cutover.

Bob PR #231 adds a persistent SQLite admission gate shared by cooperating local
processes, fail-closed process-kill recovery, and selected-provider runner
promotion wiring. Its deployed HTTP fixture passed eight live Artifacts/D1
checks using actual vault procedures with a fixture identity. Production session
authentication and routing are not configured by that qualification. Hosts on
other machines and legacy Git writers must be fenced independently; no expiring
lease or automatic orphan takeover permits the old generation to resume.

The preserved Mac/Hermes committed-tree comparison found 320 equal paths,
191 changed only on Mac and 36 changed only on Hermes relative to their common
ancestor, with no path changed differently on both sides. This is an aggregate
comparison, not a merged active tree; unpublished edits and the old server copy
remain separate reconciliation inputs. See the content-comparison evidence.

The exact draft-import bundle also passed a fresh disposable Cloudflare roundtrip:
216 commits, 14 refs and 1,460 objects matched on readback. A synthetic later
write survived export and an independent rollback restore: 217 commits and
1,463 objects. Cleanup confirmed zero remaining cloud resources. See
`docs/evidence/bob-vault-drafts-cloud-roundtrip-2026-10-03.json`. Full content
and method scripts remain in the private migration state directory.

## Reconciled private candidate

`docs/evidence/bob-vault-reconciliation-2026-10-03.json` records a private
219-commit candidate combining the preserved Mac, Hermes and old-server
histories, ten tracked working-tree changes, seventy non-ignored untracked
files, and the approved website draft import. All source trees remain unchanged.
The ignored payloads remain separately preserved in their original snapshots.

Three old-server template edits overlap the Mac/Hermes versions. The candidate
uses the Mac/Hermes templates at their existing paths and retains all three
server alternatives under `Migration Review/committed-server/Templates/`.
A project-note conflict merged cleanly using the original three-way base.
Snapshot worktree commits are pinned under `refs/migration/worktree/` and are
parents of the candidate; the imported draft head is also a parent. The previous
import remains the default main ref; the candidate is `refs/heads/reconciled`.

The actual Forge materializer accepted all 655 entries (3,118,825 bytes), and
all 647 regular files were compared byte-for-byte with their Git objects.
Eight internal symlinks satisfy the materializer policy. This candidate has not
been uploaded or activated; the earlier cloud roundtrip certifies the separate
216-commit draft-import bundle, not this new reconciled head. Fresh fenced
snapshots and production host activation remain necessary before cutover.

## Reconciled cloud roundtrip and Node activation wiring

The reconciled candidate passed a full Cloudflare roundtrip from an isolated
Node 24.14.0 runner container: 219 commits, 17 refs and 1,565 objects matched.
A new write survived export and independent rollback restore (220 commits,
1,568 objects). The rollback bundle was returned to private local storage and
its SHA-256 verified. Cloud cleanup reports zero remaining resources. See
`docs/evidence/bob-vault-reconciled-cloud-2026-10-03.json`. The initial Mac run
stopped at readback during local disk exhaustion and also cleaned up its resource;
it is not counted as passing evidence.

Bob #233 connects the optional configured host to normal Node web and runner
startup. The exact Node application revision built under webpack in an isolated
runner container; built-server smoke tests rejected anonymous access (401) and
invalid configured startup (500). This does not enable the edge app's absent
filesystem routes or provide a production credential/client module.
Live OODA stores runner threads at `/home/bob/.ooda/threads`, separate from the
personal vault, so changing that root is not part of personal-vault activation.
Fresh fenced snapshots, deployment of a qualified client and routing to a Node
vault host remain operational requirements.
