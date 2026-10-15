import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  WorkerArtifactWorkspace,
  type WorkerGitObject,
  type WorkerGitObjectStore,
} from "../src/adapters/artifact-workspace-workers.js";
import type { ArtifactWorkspaceAuthorization } from "../src/adapters/artifact-workspace-git.js";
import { GitArtifactWorkspace } from "../src/adapters/artifact-workspace-git.js";

const context = { tenant: "tenant", actor: "alice", requestId: "test" };
const binding = {
  tenant: "tenant",
  artifact: "source",
  generation: "one",
  repositoryId: "repo",
  objectFormat: "sha1" as const,
};
const at = "2026-10-15T00:00:00Z";
const bytes = (s: string) => new TextEncoder().encode(s);
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "forge-worker-objects-"));
  directories.push(dir);
  const git = (args: string[], input?: Uint8Array) =>
    execFileSync("git", ["--no-replace-objects", "-C", dir, ...args], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  git(["init", "--bare"]);
  const read = vi.fn(async (oid: string): Promise<WorkerGitObject | null> => {
    try {
      const type = git(["cat-file", "-t", oid])
        .toString()
        .trim() as WorkerGitObject["type"];
      return { type, bytes: new Uint8Array(git(["cat-file", type, oid])) };
    } catch {
      return null;
    }
  });
  const write = vi.fn(async (object: WorkerGitObject) =>
    git(["hash-object", "-w", "-t", object.type, "--stdin"], object.bytes)
      .toString()
      .trim(),
  );
  const store = { read, write };
  const authorize = vi.fn(
    async (_request: Readonly<ArtifactWorkspaceAuthorization>) => true,
  );
  const worker = new WorkerArtifactWorkspace(binding, store, authorize);
  const node = new GitArtifactWorkspace(
    { ...binding, directory: dir },
    authorize,
  );
  return { dir, git, store, authorize, worker, node };
}
it("matches native Git for binary bytes, executable files, Unicode and Git tree ordering", async () => {
  const f = await fixture();
  const changes = [
    { path: "a/b", bytes: new Uint8Array([0, 255, 128, 10]) },
    { path: "a.c", bytes: bytes("sibling") },
    { path: "é/λ", bytes: bytes("unicode") },
    { path: "run", bytes: bytes("#!/bin/sh\n"), mode: "100755" as const },
  ];
  const input = { base: null, changes, message: "root", at };
  const result = await f.worker.prepare(input, context);
  expect(result).toEqual(await f.node.prepare(input, context));
  expect(
    await f.worker.prepare(
      { ...input, changes: [...changes].reverse() },
      context,
    ),
  ).toEqual(result);
  expect(f.git(["for-each-ref"]).toString()).toBe("");
  expect(f.git(["show", result.oid + ":a/b"])).toEqual(
    Buffer.from([0, 255, 128, 10]),
  );
  f.git(["fsck", "--strict", "--no-reflogs"]);
});
it("preserves untouched paths and applies nested deletion with Git-compatible identity", async () => {
  const f = await fixture();
  const base = await f.node.prepare(
    {
      base: null,
      changes: [
        { path: "dir/old", bytes: bytes("old") },
        { path: "keep", bytes: bytes("keep") },
      ],
      message: "base",
      at,
    },
    context,
  );
  const input = {
    base,
    changes: [
      { path: "dir/old", bytes: null },
      { path: "new", bytes: bytes("new") },
    ],
    message: "updated",
    at,
  };
  const result = await f.worker.prepare(input, context);
  expect(result).toEqual(await f.node.prepare(input, context));
  expect(
    f.git(["show", "-s", "--format=%P", result.oid]).toString().trim(),
  ).toBe(base.oid);
  expect(f.git(["ls-tree", "-r", "--name-only", result.tree]).toString()).toBe(
    "keep\nnew\n",
  );
});
it("snapshots caller bytes and identities before asynchronous authorization", async () => {
  const f = await fixture();
  const data = bytes("before");
  const input = {
    base: null,
    changes: [{ path: "file", bytes: data }],
    message: "test",
    at,
  };
  f.authorize.mockImplementationOnce(async () => {
    data.fill(0);
    input.message = "changed";
    context.actor = "mallory";
    return true;
  });
  try {
    const result = await f.worker.prepare(input, context);
    expect(f.git(["show", result.oid + ":file"]).toString()).toBe("before");
    expect(
      f.git(["show", "-s", "--format=%B", result.oid]).toString().trim(),
    ).toBe("test");
    expect(f.authorize.mock.calls[0]![0].actor).toBe("alice");
  } finally {
    context.actor = "alice";
  }
});
it("rejects foreign tenants and authorization failure before accessing storage", async () => {
  const f = await fixture();
  const input = { base: null, changes: [], message: "test", at };
  await expect(
    f.worker.prepare(input, { ...context, tenant: "other" }),
  ).rejects.toMatchObject({ code: "NotPermitted" });
  f.authorize.mockResolvedValue(false);
  await expect(f.worker.prepare(input, context)).rejects.toMatchObject({
    code: "NotPermitted",
  });
  expect(f.store.read).not.toHaveBeenCalled();
  expect(f.store.write).not.toHaveBeenCalled();
});
it("rejects stale binding, substituted base objects and untrusted write receipts", async () => {
  const f = await fixture();
  const base = await f.node.prepare(
    { base: null, changes: [], message: "base", at },
    context,
  );
  await expect(
    f.worker.prepare(
      {
        base: { ...base, generation: "old" },
        changes: [],
        message: "test",
        at,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "VersionConflict" });
  f.store.read.mockResolvedValueOnce({
    type: "commit",
    bytes: bytes("substitution"),
  });
  await expect(
    f.worker.prepare({ base, changes: [], message: "test", at }, context),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  f.store.write.mockResolvedValueOnce("0".repeat(40));
  await expect(
    f.worker.prepare({ base: null, changes: [], message: "test", at }, context),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
});
it("rejects unsafe and duplicate paths, conflicts, unsupported modes and budget exhaustion without writes", async () => {
  const f = await fixture();
  for (const path of ["../x", "/x", "a/.GIT/config", "a\\b", "a//b", "x\0y"]) {
    await expect(
      f.worker.prepare(
        {
          base: null,
          changes: [{ path, bytes: bytes("x") }],
          message: "test",
          at,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  }
  await expect(
    f.worker.prepare(
      {
        base: null,
        changes: [
          { path: "x", bytes: bytes("x") },
          { path: "x", bytes: null },
        ],
        message: "test",
        at,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  await expect(
    f.worker.prepare(
      {
        base: null,
        changes: [
          { path: "x", bytes: bytes("x") },
          { path: "x/y", bytes: bytes("y") },
        ],
        message: "test",
        at,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  await expect(
    f.worker.prepare(
      {
        base: null,
        changes: Array.from({ length: 1025 }, (_, i) => ({
          path: String(i),
          bytes: null,
        })),
        message: "test",
        at,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "BudgetExceeded" });
  await expect(
    f.worker.prepare(
      {
        base: null,
        changes: [
          { path: "huge", bytes: new Uint8Array(32 * 1024 * 1024 + 1) },
        ],
        message: "test",
        at,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "BudgetExceeded" });
  expect(f.store.write).not.toHaveBeenCalled();
});
it("reports storage failure without returning a publishable revision", async () => {
  const store: WorkerGitObjectStore = {
    read: async () => null,
    write: async () => {
      throw new Error("private provider error");
    },
  };
  await expect(
    new WorkerArtifactWorkspace(binding, store, async () => true).prepare(
      { base: null, changes: [], message: "test", at },
      context,
    ),
  ).rejects.toMatchObject({
    code: "DependencyUnavailable",
    detail: "Artifact object write failed",
  });
});
it("supports file-directory replacements after explicit deletion of old entries", async () => {
  const f = await fixture();
  const base = await f.node.prepare(
    {
      base: null,
      changes: [
        { path: "dir/file", bytes: bytes("old") },
        { path: "flat", bytes: bytes("old") },
      ],
      message: "base",
      at,
    },
    context,
  );
  const input = {
    base,
    changes: [
      { path: "dir", bytes: bytes("new") },
      { path: "dir/file", bytes: null },
      { path: "flat", bytes: null },
      { path: "flat/file", bytes: bytes("new") },
    ],
    message: "replace",
    at,
  };
  const result = await f.worker.prepare(input, context);
  // Native Git's index update is order-sensitive; compare the same explicit delete-first operation.
  expect(result).toEqual(
    await f.node.prepare(
      {
        ...input,
        changes: [...input.changes].sort(
          (a, b) => Number(a.bytes !== null) - Number(b.bytes !== null),
        ),
      },
      context,
    ),
  );
});
it("rejects invalid Unicode rather than silently replacing path bytes", async () => {
  const f = await fixture();
  await expect(
    f.worker.prepare(
      {
        base: null,
        changes: [{ path: "\ud800", bytes: bytes("bad") }],
        message: "test",
        at,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  expect(f.store.write).not.toHaveBeenCalled();
});
it("produces a Git-valid portable pack without invoking the object store or moving refs", async () => {
  const { WorkerGitPackStore } =
    await import("../src/adapters/artifact-workspace-workers.js");
  const f = await fixture();
  const packStore = new WorkerGitPackStore();
  const workspace = new WorkerArtifactWorkspace(
    binding,
    packStore,
    async () => true,
  );
  const input = {
    base: null,
    changes: [
      { path: "binary", bytes: new Uint8Array([0, 255, 128]) },
      { path: "dir/run", bytes: bytes("script"), mode: "100755" as const },
    ],
    message: "pack",
    at,
  };
  const revision = await workspace.prepare(input, context);
  const pack = await packStore.pack();
  f.git(["index-pack", "--strict", "--stdin"], pack);
  expect(f.git(["show", revision.oid + ":binary"])).toEqual(
    Buffer.from([0, 255, 128]),
  );
  expect(revision).toEqual(await f.node.prepare(input, context));
  expect(f.git(["for-each-ref"]).length).toBe(0);
  const object = await packStore.read(revision.oid);
  object!.bytes.fill(0);
  expect((await packStore.read(revision.oid))!.bytes).not.toEqual(
    object!.bytes,
  );
});
it("packs a child commit against existing remote objects and deduplicates retries", async () => {
  const { WorkerGitPackStore } =
    await import("../src/adapters/artifact-workspace-workers.js");
  const f = await fixture();
  const base = await f.node.prepare(
    {
      base: null,
      changes: [{ path: "keep", bytes: bytes("base") }],
      message: "base",
      at,
    },
    context,
  );
  const sink = new WorkerGitPackStore(f.store),
    worker = new WorkerArtifactWorkspace(binding, sink, async () => true);
  const input = {
    base,
    changes: [{ path: "next", bytes: bytes("next") }],
    message: "child",
    at,
  };
  const revision = await worker.prepare(input, context);
  const first = await sink.pack();
  expect(await worker.prepare(input, context)).toEqual(revision);
  expect(await sink.pack()).toEqual(first);
  f.git(["index-pack", "--strict", "--stdin"], first);
  expect(f.git(["show", revision.oid + ":keep"]).toString()).toBe("base");
});
