import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  WorkerArtifactWorkspace,
  WorkerGitPackStore,
  type WorkerGitObject,
} from "../src/adapters/artifact-workspace-workers.js";
import { GitArtifactWorkspace } from "../src/adapters/artifact-workspace-git.js";

// FORG-22: incremental preparation, caller identity, three-way merge and diff
// inside Workers, checked against native Git.

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
  const dir = await mkdtemp(join(tmpdir(), "forge-worker-incremental-"));
  directories.push(dir);
  const git = (args: string[], input?: Uint8Array | string) =>
    execFileSync("git", ["--no-replace-objects", "-C", dir, ...args], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Forge artifact",
        GIT_AUTHOR_EMAIL: "artifact@forge.invalid",
        GIT_COMMITTER_NAME: "Forge artifact",
        GIT_COMMITTER_EMAIL: "artifact@forge.invalid",
        GIT_AUTHOR_DATE: "1791072000 +0000",
        GIT_COMMITTER_DATE: "1791072000 +0000",
      },
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
  const authorize = async () => true;
  const worker = new WorkerArtifactWorkspace(binding, store, authorize);
  const node = new GitArtifactWorkspace(
    { ...binding, directory: dir },
    authorize,
  );
  const prepare = (
    base: Awaited<ReturnType<typeof worker.prepare>> | null,
    files: Record<string, string | null>,
    message = "change",
  ) =>
    node.prepare(
      {
        base,
        changes: Object.entries(files).map(([path, text]) => ({
          path,
          bytes: text === null ? null : bytes(text),
        })),
        message,
        at,
      },
      context,
    );
  return { dir, git, store, worker, node, prepare };
}
/** A base commit wider than any single preparation budget, built with Git plumbing. */
async function wideBase(f: Awaited<ReturnType<typeof fixture>>) {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const work = await mkdtemp(join(tmpdir(), "forge-worker-wide-"));
  directories.push(work);
  for (let d = 0; d < 40; d++) {
    const dir = join(work, `d${String(d).padStart(2, "0")}`);
    await mkdir(dir);
    for (let i = 0; i < 40; i++)
      await writeFile(
        join(dir, `f${String(i).padStart(2, "0")}.txt`),
        `d${d} f${i}\n`,
      );
  }
  const index = join(f.dir, "wide.index");
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_WORK_TREE: work };
  execFileSync("git", ["-C", f.dir, "add", "-A", "."], { env, cwd: work });
  const tree = execFileSync("git", ["-C", f.dir, "write-tree"], { env })
    .toString()
    .trim();
  const oid = f.git(["commit-tree", tree, "-m", "wide"]).toString().trim();
  return { ...binding, oid, tree };
}

it("changes one file in a 1,600-file base by reading only the trees on its path", async () => {
  const f = await fixture();
  const base = await wideBase(f);
  const sink = new WorkerGitPackStore(f.store),
    worker = new WorkerArtifactWorkspace(binding, sink, async () => true);
  f.store.read.mockClear();
  const revision = await worker.prepare(
    {
      base,
      changes: [{ path: "d07/f03.txt", bytes: bytes("changed\n") }],
      message: "one",
      at,
    },
    context,
  );
  // The base commit, the root tree and d07: nothing else is read.
  expect(f.store.read.mock.calls.map(([oid]) => oid)).toHaveLength(3);
  const pack = await sink.pack();
  expect(new DataView(pack.buffer).getUint32(8)).toBe(4); // blob, d07, root, commit
  f.git(["index-pack", "--strict", "--stdin"], pack);
  f.git(["fsck", "--strict", "--no-dangling", revision.oid]);
  const files = f
    .git(["ls-tree", "-r", "--name-only", revision.oid])
    .toString()
    .trim()
    .split("\n");
  expect(files).toHaveLength(1600);
  expect(f.git(["show", `${revision.oid}:d07/f03.txt`]).toString()).toBe(
    "changed\n",
  );
  expect(
    f
      .git(["diff-tree", "-r", "--name-only", base.oid, revision.oid])
      .toString()
      .trim(),
  ).toBe("d07/f03.txt");
});

it("deletes the last file of a directory and creates new directories lazily", async () => {
  const f = await fixture();
  const base = await f.prepare(null, {
    "a/only": "x",
    "b/keep": "k",
    "c/d/e": "e",
  });
  const viaNode = await f.prepare(base, {
    "a/only": null,
    "c/d/e": null,
    "n/m/new": "n",
  });
  const viaWorker = await f.worker.prepare(
    {
      base,
      changes: [
        { path: "a/only", bytes: null },
        { path: "c/d/e", bytes: null },
        { path: "n/m/new", bytes: bytes("n") },
      ],
      message: "change",
      at,
    },
    context,
  );
  expect(viaWorker).toEqual(viaNode);
  const missing = await f.worker.prepare(
    {
      base,
      changes: [{ path: "zz/absent", bytes: null }],
      message: "change",
      at,
    },
    context,
  );
  expect(missing.tree).toBe(base.tree);
});

it("records the caller's author and committer and rejects unsafe identities", async () => {
  const f = await fixture();
  const revision = await f.worker.prepare(
    {
      base: null,
      changes: [{ path: "a", bytes: bytes("a") }],
      message: "authored",
      at,
      author: { name: "Agent Smith", email: "agent@loom.invalid" },
    },
    context,
  );
  expect(
    f
      .git(["show", "-s", "--format=%an <%ae>|%cn <%ce>", revision.oid])
      .toString()
      .trim(),
  ).toBe("Agent Smith <agent@loom.invalid>|Agent Smith <agent@loom.invalid>");
  for (const author of [
    { name: "x>", email: "a@b" },
    { name: "x", email: "a\n@b" },
    { name: " x", email: "a@b" },
    { name: "", email: "a@b" },
  ]) {
    await expect(
      f.worker.prepare(
        { base: null, changes: [], message: "m", at, author },
        context,
      ),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  }
  expect(f.store.write).toHaveBeenCalledTimes(3);
});

it("merges like git merge-tree when the sides touch different files", async () => {
  const f = await fixture();
  const base = await f.prepare(null, {
    "shared/keep": "k\n",
    "shared/drop": "d\n",
    edit: "base\n",
    same: "s\n",
  });
  const left = await f.prepare(
    base,
    { "shared/drop": null, "left/new": "l\n", same: "both\n" },
    "left",
  );
  const right = await f.prepare(
    base,
    { edit: "right\n", "shared/added": "r\n", same: "both\n" },
    "right",
  );
  const input = { base, left, right, message: "merge", at };
  const viaNode = await f.node.merge(input, context);
  const viaWorker = await f.worker.merge(input, context);
  expect(viaWorker).toEqual(viaNode);
  expect(viaWorker.status).toBe("prepared");
  if (viaWorker.status === "prepared")
    expect(
      f
        .git(["show", "-s", "--format=%P", viaWorker.revision.oid])
        .toString()
        .trim(),
    ).toBe(`${left.oid} ${right.oid}`);
});

it("reports a conflict for any path both sides changed, including edits Git would combine", async () => {
  const f = await fixture();
  const base = await f.prepare(null, { lines: "1\n2\n3\n4\n5\n6\n", x: "x" });
  const left = await f.prepare(
    base,
    {
      lines: "one\n2\n3\n4\n5\n6\n",
      "x/inner": null,
      x: null,
      "dir/file": "l",
    },
    "left",
  );
  const withFile = await f.prepare(left, {}, "noop");
  void withFile;
  const right = await f.prepare(
    base,
    { lines: "1\n2\n3\n4\n5\nsix\n", x: "changed", dir: "file" },
    "right",
  );
  // Git combines the non-overlapping line edits; the Worker merge does not.
  const viaNode = await f.node.merge(
    { base, left, right, message: "m", at },
    context,
  );
  expect(viaNode).toMatchObject({ status: "conflicted" });
  const viaWorker = await f.worker.merge(
    { base, left, right, message: "m", at },
    context,
  );
  expect(viaWorker).toEqual({
    status: "conflicted",
    paths: ["dir", "lines", "x"],
  });
  expect(f.store.write).not.toHaveBeenCalled();
});

it("rejects identical parents, replaced pins and a merge base that is not the unique best ancestor", async () => {
  const f = await fixture();
  const root = await f.prepare(null, { a: "a" });
  const left = await f.prepare(root, { l: "l" }, "left");
  const right = await f.prepare(root, { r: "r" }, "right");
  await expect(
    f.worker.merge(
      { base: root, left, right: left, message: "m", at },
      context,
    ),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
  await expect(
    f.worker.merge({ base: left, left, right, message: "m", at }, context),
  ).rejects.toMatchObject({ code: "VersionConflict" });
  await expect(
    f.worker.merge(
      { base: { ...root, generation: "old" }, left, right, message: "m", at },
      context,
    ),
  ).rejects.toMatchObject({ code: "VersionConflict" });
  // Criss-cross: two best common ancestors.
  const m1 = await f.node.merge(
    { base: root, left, right, message: "m1", at },
    context,
  );
  const m2 = await f.node.merge(
    { base: root, left: right, right: left, message: "m2", at },
    context,
  );
  if (m1.status !== "prepared" || m2.status !== "prepared")
    throw new Error("setup");
  const x = await f.prepare(m1.revision, { x: "x" }, "x");
  const y = await f.prepare(m2.revision, { y: "y" }, "y");
  await expect(
    f.worker.merge(
      { base: left, left: x, right: y, message: "m", at },
      context,
    ),
  ).rejects.toMatchObject({ code: "VersionConflict" });
  // A longer history still finds the unique base.
  let tip = left;
  for (let i = 0; i < 5; i++)
    tip = await f.prepare(tip, { [`n${i}`]: String(i) }, `n${i}`);
  expect(
    await f.worker.merge(
      { base: root, left: tip, right, message: "m", at },
      context,
    ),
  ).toEqual(
    await f.node.merge(
      { base: root, left: tip, right, message: "m", at },
      context,
    ),
  );
});

it("diffs like git diff-tree, including mode and file-to-directory changes", async () => {
  const f = await fixture();
  const a = await f.prepare(null, {
    "keep/x": "x",
    gone: "g",
    edit: "1",
    swap: "file",
    "deep/a/b": "b",
  });
  const b = await f.node.prepare(
    {
      base: a,
      changes: [
        { path: "gone", bytes: null },
        { path: "edit", bytes: bytes("2") },
        { path: "swap", bytes: null },
        { path: "swap/inner", bytes: bytes("dir") },
        { path: "deep/a/c", bytes: bytes("c") },
        { path: "keep/x", bytes: bytes("x"), mode: "100755" },
        { path: "added", bytes: bytes("new") },
      ],
      message: "b",
      at,
    },
    context,
  );
  const expected = await f.node.diff(a, b, context);
  expect(await f.worker.diff(a, b, context)).toEqual(expected);
  expect(await f.worker.diff(b, a, context)).toEqual(
    await f.node.diff(b, a, context),
  );
  expect(await f.worker.diff(a, a, context)).toEqual([]);
  await expect(
    f.worker.diff(a, b, context, { maxEntries: 2 }),
  ).rejects.toMatchObject({
    code: "BudgetExceeded",
  });
});

it("uses parsed commits from stores that cannot return raw commit bytes", async () => {
  const f = await fixture();
  const base = await f.prepare(null, { a: "a" });
  const readCommit = vi.fn(async (oid: string) => {
    const [tree, parents, time] = f
      .git(["show", "-s", "--format=%T%n%P%n%ct", oid])
      .toString()
      .split("\n");
    return {
      tree: tree!,
      parents: parents ? parents.split(" ") : [],
      time: Number(time),
    };
  });
  const store = {
    read: vi.fn(async (oid: string) => {
      const object = await f.store.read(oid);
      return object?.type === "commit" ? null : object;
    }),
    write: f.store.write,
    readCommit,
  };
  const worker = new WorkerArtifactWorkspace(binding, store, async () => true);
  const next = await worker.prepare(
    { base, changes: [{ path: "b", bytes: bytes("b") }], message: "next", at },
    context,
  );
  expect(readCommit).toHaveBeenCalledWith(base.oid);
  expect(next).toEqual(await f.prepare(base, { b: "b" }, "next"));
  readCommit.mockResolvedValueOnce({
    tree: "f".repeat(40),
    parents: [],
    time: 0,
  });
  await expect(
    worker.prepare({ base, changes: [], message: "m", at }, context),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
});

it("prepares and merges on an existing branch through the Artifacts binding's object reads", async () => {
  const { cloudflareArtifactsObjectSource } =
    await import("../src/adapters/cloudflare-artifacts.js");
  const f = await fixture();
  // A fake repo handle with the binding's shapes (checked live 2026-10-15), backed by Git.
  const repo = {
    readCommit: vi.fn(async (oid: string) => {
      try {
        const [tree, parents, time] = f
          .git(["show", "-s", "--format=%T%n%P%n%ct", oid])
          .toString()
          .split("\n");
        return {
          hash: oid,
          treeHash: tree!,
          parents: parents ? parents.split(" ") : [],
          committedAt: Number(time),
        };
      } catch {
        return null;
      }
    }),
    readTree: vi.fn(async (oid: string) => {
      try {
        if (f.git(["cat-file", "-t", oid]).toString().trim() !== "tree")
          return null;
      } catch {
        return null;
      }
      return f
        .git(["ls-tree", "-z", oid])
        .toString()
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t");
          const [mode, type, hash] = meta!.split(" ");
          return {
            name: name!,
            mode: mode === "040000" ? "40000" : mode!,
            hash: hash!,
            type:
              type === "tree" ? "tree" : mode === "120000" ? "symlink" : "blob",
          };
        });
    }),
    readBlob: vi.fn(async (oid: string) => {
      try {
        return new Blob([new Uint8Array(f.git(["cat-file", "blob", oid]))]);
      } catch {
        return null;
      }
    }),
  };
  const base = await f.prepare(null, {
    "src/a.ts": "a",
    "src/b.ts": "b",
    "README.md": "r",
  });
  const left = await f.prepare(base, { "src/a.ts": "A" }, "left");
  const sink = new WorkerGitPackStore(cloudflareArtifactsObjectSource(repo));
  const worker = new WorkerArtifactWorkspace(binding, sink, async () => true);
  const right = await worker.prepare(
    {
      base,
      changes: [{ path: "src/c.ts", bytes: bytes("c") }],
      message: "right",
      at,
    },
    context,
  );
  expect(right).toEqual(await f.prepare(base, { "src/c.ts": "c" }, "right"));
  expect(repo.readBlob).not.toHaveBeenCalled();
  const merged = await worker.merge(
    { base, left, right, message: "merge", at },
    context,
  );
  expect(merged).toEqual(
    await f.node.merge({ base, left, right, message: "merge", at }, context),
  );
  f.git(["index-pack", "--strict", "--stdin"], await sink.pack());
  // A tree whose entries do not encode to its ID is rejected.
  repo.readTree.mockResolvedValueOnce([
    { name: "x", mode: "100644", hash: "a".repeat(40), type: "blob" },
  ]);
  await expect(
    worker.prepare({ base, changes: [], message: "m", at }, context),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
});

it("applies resolutions to conflicting paths and rejects resolutions for clean paths", async () => {
  const f = await fixture();
  const base = await f.prepare(null, {
    shared: "base\n",
    other: "o\n",
    gone: "g\n",
  });
  const left = await f.prepare(
    base,
    { shared: "left\n", gone: "left\n", l: "l" },
    "left",
  );
  const right = await f.prepare(
    base,
    { shared: "right\n", gone: null, r: "r" },
    "right",
  );
  const input = { base, left, right, message: "resolved", at };
  expect(await f.worker.merge(input, context)).toEqual({
    status: "conflicted",
    paths: ["gone", "shared"],
  });
  const partial = await f.worker.merge(
    { ...input, resolutions: [{ path: "shared", bytes: bytes("both\n") }] },
    context,
  );
  expect(partial).toEqual({ status: "conflicted", paths: ["gone"] });
  const merged = await f.worker.merge(
    {
      ...input,
      resolutions: [
        { path: "shared", bytes: bytes("both\n") },
        { path: "gone", bytes: null },
      ],
    },
    context,
  );
  if (merged.status !== "prepared") throw new Error("expected a merge");
  const oid = merged.revision.oid;
  expect(f.git(["show", "-s", "--format=%P", oid]).toString().trim()).toBe(
    `${left.oid} ${right.oid}`,
  );
  expect(f.git(["show", `${oid}:shared`]).toString()).toBe("both\n");
  expect(
    f.git(["ls-tree", "--name-only", oid]).toString().trim().split("\n"),
  ).toEqual(["l", "other", "r", "shared"]);
  await expect(
    f.worker.merge(
      {
        ...input,
        resolutions: [
          { path: "shared", bytes: bytes("x") },
          { path: "other", bytes: bytes("x") },
        ],
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "ValidationFailed" });
});
