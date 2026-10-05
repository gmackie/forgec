import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitArtifactWorkspace } from "../src/adapters/artifact-workspace-git.js";
const ctx = { tenant: "t", actor: "alice", requestId: "test" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "forge-workspace-"));
  execFileSync("git", ["init", "--bare", dir], { stdio: "pipe" });
  const workspace = new GitArtifactWorkspace(
    {
      directory: dir,
      tenant: "t",
      artifact: "source",
      generation: "one",
      repositoryId: "repo",
      objectFormat: "sha1",
    },
    async () => true,
  );
  const change = (path: string, text: string) => ({
    path,
    bytes: new TextEncoder().encode(text),
    mode: "100644" as const,
  });
  const prepare = (base: any, changes: any[], message = "change") =>
    workspace.prepare(
      { base, changes, message, at: "2026-10-02T00:00:00Z" },
      ctx,
    );
  return {
    dir,
    workspace,
    change,
    prepare,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
it("prepares deterministic immutable commits without moving any refs", async () => {
  const f = await fixture();
  try {
    const a = await f.prepare(null, [f.change("notes/a.md", "hello")]);
    const again = await f.prepare(null, [f.change("notes/a.md", "hello")]);
    expect(again).toEqual(a);
    const b = await f.prepare(a, [
      f.change("notes/a.md", "updated"),
      f.change("b.bin", "binary"),
    ]);
    const diff = await f.workspace.diff(a, b, ctx);
    expect(diff.map((x) => [x.path, x.status])).toEqual([
      ["b.bin", "added"],
      ["notes/a.md", "modified"],
    ]);
    expect(
      execFileSync(
        "git",
        ["-C", f.dir, "for-each-ref", "--format=%(refname)"],
        { stdio: "pipe", encoding: "utf8" },
      ),
    ).toBe("");
  } finally {
    await f.close();
  }
});
it("merges both parents or returns explicit conflicts without publishing", async () => {
  const f = await fixture();
  try {
    const base = await f.prepare(null, [f.change("shared", "base\n")]);
    const left = await f.prepare(base, [f.change("left", "a")], "left");
    const right = await f.prepare(base, [f.change("right", "b")], "right");
    const merged = await f.workspace.merge(
      { base, left, right, message: "merge", at: "2026-10-02T00:00:00Z" },
      ctx,
    );
    expect(merged.status).toBe("prepared");
    if (merged.status === "prepared")
      expect(
        execFileSync(
          "git",
          ["-C", f.dir, "show", "-s", "--format=%P", merged.revision.oid],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(left.oid + " " + right.oid);
    const x = await f.prepare(base, [f.change("shared", "x\n")]);
    const y = await f.prepare(base, [f.change("shared", "y\n")]);
    const conflict = await f.workspace.merge(
      {
        base,
        left: x,
        right: y,
        message: "conflict",
        at: "2026-10-02T00:00:00Z",
      },
      ctx,
    );
    expect(conflict).toMatchObject({ status: "conflicted", paths: ["shared"] });
  } finally {
    await f.close();
  }
});
it("rejects unauthorized, replaced pins, unsafe paths, duplicate changes and exhausted limits", async () => {
  const f = await fixture();
  try {
    const base = await f.prepare(null, [f.change("a", "a")]);
    await expect(
      f.workspace.prepare(
        {
          base,
          changes: [f.change("../escape", "x")],
          message: "x",
          at: "2026-10-02T00:00:00Z",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      f.prepare(base, [f.change("a", "x"), f.change("a", "y")]),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(
      f.workspace.diff(base, { ...base, generation: "old" }, ctx),
    ).rejects.toMatchObject({ code: "VersionConflict" });
    await expect(
      f.workspace.diff(base, base, { ...ctx, tenant: "other" }),
    ).rejects.toMatchObject({ code: "NotPermitted" });
    const changed = await f.prepare(base, [
      f.change("b", "b"),
      f.change("c", "c"),
    ]);
    await expect(
      f.workspace.diff(base, changed, ctx, { maxEntries: 1 }),
    ).rejects.toMatchObject({ code: "BudgetExceeded" });
  } finally {
    await f.close();
  }
});
it("preserves binary bytes and executable modes and supports explicit deletion", async () => {
  const f = await fixture();
  try {
    const bytes = new Uint8Array([0, 1, 128, 255]);
    const base = await f.prepare(null, [
      { path: "run", bytes, mode: "100755" },
    ]);
    expect(
      new Uint8Array(
        execFileSync("git", [
          "-C",
          f.dir,
          "cat-file",
          "blob",
          base.oid + ":run",
        ]),
      ),
    ).toEqual(bytes);
    const target = await f.prepare(base, [{ path: "run", bytes: null }]);
    expect(await f.workspace.diff(base, target, ctx)).toMatchObject([
      { path: "run", status: "deleted", beforeMode: "100755", after: null },
    ]);
  } finally {
    await f.close();
  }
});
it("snapshots bytes before authorization and denies provider work on authorization failure", async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode("original");
    let requests = 0;
    const workspace = new GitArtifactWorkspace(
      {
        directory: f.dir,
        tenant: "t",
        artifact: "source",
        generation: "one",
        repositoryId: "repo",
        objectFormat: "sha1",
      },
      async () => {
        requests++;
        bytes.fill(0);
        return true;
      },
    );
    const pin = await workspace.prepare(
      {
        base: null,
        changes: [{ path: "a", bytes }],
        message: "test",
        at: "2026-10-02T00:00:00Z",
      },
      ctx,
    );
    expect(
      execFileSync("git", ["-C", f.dir, "cat-file", "blob", pin.oid + ":a"], {
        encoding: "utf8",
      }),
    ).toBe("original");
    expect(requests).toBe(1);
    const denied = new GitArtifactWorkspace(
      {
        directory: f.dir,
        tenant: "t",
        artifact: "source",
        generation: "one",
        repositoryId: "repo",
        objectFormat: "sha1",
      },
      async () => {
        throw Error("secret");
      },
    );
    await expect(denied.diff(pin, pin, ctx)).rejects.toMatchObject({
      code: "NotPermitted",
    });
    await expect(
      f.workspace.diff(pin, { ...pin, tree: "a".repeat(40) }, ctx),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
  } finally {
    await f.close();
  }
});
it("rejects the wrong merge base before creating a result", async () => {
  const f = await fixture();
  try {
    const root = await f.prepare(null, [f.change("a", "a")]);
    const base = await f.prepare(root, [f.change("b", "b")]);
    const left = await f.prepare(base, [f.change("l", "l")]);
    const right = await f.prepare(base, [f.change("r", "r")]);
    await expect(
      f.workspace.merge(
        {
          base: root,
          left,
          right,
          message: "merge",
          at: "2026-10-02T00:00:00Z",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VersionConflict" });
  } finally {
    await f.close();
  }
});

it("materializes exact pinned bytes and modes into a new directory without overwriting", async () => {
  const { readFile, stat, mkdir } = await import("node:fs/promises");
  const f = await fixture();
  try {
    const revision = await f.prepare(null, [
      {
        path: "nested/binary",
        bytes: new Uint8Array([0, 128, 255]),
        mode: "100755",
      },
      f.change("readme", "hello"),
    ]);
    const destination = join(f.dir, "materialized");
    const result = await f.workspace.materialize(revision, destination, ctx, {
      maxFiles: 2,
      maxBytes: 8,
    });
    expect(result).toEqual({ files: 2, bytes: 8 });
    expect(
      new Uint8Array(await readFile(join(destination, "nested/binary"))),
    ).toEqual(new Uint8Array([0, 128, 255]));
    expect((await stat(join(destination, "nested/binary"))).mode & 0o111).toBe(
      0o111,
    );
    await expect(
      f.workspace.materialize(revision, destination, ctx),
    ).rejects.toMatchObject({ code: "VersionConflict" });
    expect(await readFile(join(destination, "readme"), "utf8")).toBe("hello");
    const budget = join(f.dir, "over-budget");
    await expect(
      f.workspace.materialize(revision, budget, ctx, { maxFiles: 1 }),
    ).rejects.toMatchObject({ code: "BudgetExceeded" });
    await expect(stat(budget)).rejects.toMatchObject({ code: "ENOENT" });
    const foreign = join(f.dir, "foreign");
    await expect(
      f.workspace.materialize(revision, foreign, { ...ctx, tenant: "other" }),
    ).rejects.toMatchObject({ code: "NotPermitted" });
    await expect(stat(foreign)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(f.dir, "existing"));
    await expect(
      f.workspace.materialize(revision, join(f.dir, "existing"), ctx),
    ).rejects.toMatchObject({ code: "VersionConflict" });
  } finally {
    await f.close();
  }
});
it("refuses symlink materialization and identical merge parents", async () => {
  const { stat } = await import("node:fs/promises");
  const f = await fixture();
  try {
    const base = await f.prepare(null, [f.change("file", "content")]);
    await expect(
      f.workspace.merge(
        {
          base,
          left: base,
          right: base,
          message: "duplicate parents",
          at: "2026-10-02T00:00:00Z",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-C", f.dir, ...args], {
        input,
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
      }).trim();
    const blob = git(["hash-object", "-w", "--stdin"], "../../outside");
    const tree = git(["mktree"], `120000 blob ${blob}\tlink\n`);
    const oid = git(["commit-tree", tree], "link\n");
    const dest = join(f.dir, "symlink");
    await expect(
      f.workspace.materialize({ ...base, oid, tree }, dest, ctx),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(stat(dest)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await f.close();
  }
});

it("materializes explicitly opted-in internal file symlinks without changing target text", async () => {
  const { readFile, readlink, lstat } = await import("node:fs/promises");
  const f = await fixture();
  try {
    const base = await f.prepare(null, [f.change("file", "content")]);
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-C", f.dir, ...args], {
        input,
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
      }).trim();
    const blob = git(["hash-object", "-w", "--stdin"], "../file");
    const nested = git(["mktree"], `120000 blob ${blob}\tlink\n`);
    const file = git(["rev-parse", `${base.oid}:file`]);
    const tree = git(
      ["mktree"],
      `100644 blob ${file}\tfile\n040000 tree ${nested}\tnested\n`,
    );
    const oid = git(["commit-tree", tree], "internal link\n");
    const pin = { ...base, tree, oid };
    await expect(
      f.workspace.materialize(pin, join(f.dir, "default"), ctx),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    const destination = join(f.dir, "opted-in");
    const result = await f.workspace.materialize(pin, destination, ctx, {
      symlinks: "internal",
    });
    expect(result).toEqual({ files: 2, bytes: 14 });
    expect(
      (await lstat(join(destination, "nested/link"))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(destination, "nested/link"))).toBe("../file");
    expect(await readFile(join(destination, "nested/link"), "utf8")).toBe(
      "content",
    );
  } finally {
    await f.close();
  }
});

it.each([
  "/etc/passwd",
  "../../outside",
  "../missing",
  "../link",
  "../.git/config",
  "..\\file",
  "../file\0suffix",
])(
  "rejects unsafe, dangling or chained symlink target %j before creating output",
  async (target) => {
    const { lstat } = await import("node:fs/promises");
    const f = await fixture();
    try {
      const base = await f.prepare(null, [f.change("file", "content")]);
      const git = (args: string[], input?: string) =>
        execFileSync("git", ["-C", f.dir, ...args], {
          input,
          encoding: "utf8",
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
          },
        }).trim();
      const blob = git(["hash-object", "-w", "--stdin"], target);
      const nested = git(["mktree"], `120000 blob ${blob}\tlink\n`);
      const direct = git(["hash-object", "-w", "--stdin"], "file");
      const file = git(["rev-parse", `${base.oid}:file`]);
      const tree = git(
        ["mktree"],
        `100644 blob ${file}\tfile\n120000 blob ${direct}\tlink\n040000 tree ${nested}\tnested\n`,
      );
      const oid = git(["commit-tree", tree], "unsafe link\n");
      const destination = join(f.dir, "rejected");
      await expect(
        f.workspace.materialize({ ...base, tree, oid }, destination, ctx, {
          symlinks: "internal",
        }),
      ).rejects.toMatchObject({ code: "ValidationFailed" });
      await expect(lstat(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.close();
    }
  },
);

async function directoryLinkFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  links: { a: string; b?: string },
) {
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", f.dir, ...args], {
      input,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  const base = await f.prepare(null, [f.change("file", "content")]);
  const file = git(["rev-parse", `${base.oid}:file`]);
  const subtree = (target?: string) => {
    const blob =
      target === undefined
        ? null
        : git(["hash-object", "-w", "--stdin"], target);
    return git(
      ["mktree"],
      `100644 blob ${file}\tfile\n` +
        (blob ? `120000 blob ${blob}\tlink\n` : ""),
    );
  };
  const tree = git(
    ["mktree"],
    `040000 tree ${subtree(links.a)}\ta\n040000 tree ${subtree(links.b)}\tb\n`,
  );
  return {
    ...base,
    tree,
    oid: git(["commit-tree", tree], "directory links\n"),
  };
}
it("preserves an internal directory alias after validating the full tree", async () => {
  const { readFile, readlink } = await import("node:fs/promises");
  const f = await fixture();
  try {
    const pin = await directoryLinkFixture(f, { a: "../b" });
    const destination = join(f.dir, "directory-alias");
    await f.workspace.materialize(pin, destination, ctx, {
      symlinks: "internal",
    });
    expect(await readlink(join(destination, "a/link"))).toBe("../b");
    expect(await readFile(join(destination, "a/link/file"), "utf8")).toBe(
      "content",
    );
  } finally {
    await f.close();
  }
});
it.each([{ a: "../a" }, { a: ".." }, { a: "../b", b: "../a" }])(
  "rejects recursive directory aliases %j before creating output",
  async (links) => {
    const { lstat } = await import("node:fs/promises");
    const f = await fixture();
    try {
      const pin = await directoryLinkFixture(f, links);
      const destination = join(f.dir, "directory-cycle");
      await expect(
        f.workspace.materialize(pin, destination, ctx, {
          symlinks: "internal",
        }),
      ).rejects.toMatchObject({ code: "ValidationFailed" });
      await expect(lstat(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await f.close();
    }
  },
);
