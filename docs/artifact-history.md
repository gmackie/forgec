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
