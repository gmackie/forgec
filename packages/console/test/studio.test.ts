import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { sqliteStudio } from "../src/studio-sqlite.js";
import type { GitRepository } from "../src/git.js";

const migration = readFileSync(
  new URL("../migrations/0003_studio.sql", import.meta.url),
  "utf8",
);
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const studio = sqliteStudio(
    db,
    migration,
    "a-long-test-cursor-secret-1234567890",
  );
  const heads: Record<string, string> = {
    main: "a".repeat(40),
    change: "b".repeat(40),
  };
  const git = (branch = "main", id = "demo"): GitRepository =>
    ({
      project: {
        id,
        name: "Demo",
        repository: "owner/repo",
        branch,
        root: "src",
      },
      onBranch: (b: string) => git(b, id),
      head: async () => heads[branch],
      snapshot: async (revision = heads[branch]) => ({
        revision,
        files: [
          {
            path: "app.forge",
            text:
              revision === "a".repeat(40) ? "purpose Before" : "purpose After",
          },
        ],
      }),
    }) as unknown as GitRepository;
  const submit = () =>
    studio.submit(git(), {
      title: "Improve app",
      description: "Review this",
      baseBranch: "main",
      headBranch: "change",
      headRevision: heads.change!,
    });
  return { db, studio, heads, git, submit };
}
it("dogfoods generated inventory, review diffs, comments, and lifecycle decisions", async () => {
  const { studio, git, submit, db } = setup();
  await studio.observe(
    git(),
    [{ name: "main", revision: "a".repeat(40) }],
    [
      {
        revision: "a".repeat(40),
        message: "Initial",
        url: "https://example.test",
        author: "Extra provider field",
      } as any,
    ],
  );
  expect((await studio.list(git(), "RepositoryCommit")).items).toHaveLength(1);
  await studio.observe(git(), [{ name: "main", revision: "c".repeat(40) }], []);
  expect((await studio.list(git(), "Branch")).items[0].head).toBe(
    "c".repeat(40),
  );
  const review = await submit();
  expect(review.status).toBe("Open");
  await studio.call("ReviewComment", "create", {
    review: review.id,
    body: "Looks good",
    author: "console-administrator",
  });
  const reopened = sqliteStudio(
    db,
    migration,
    "a-long-test-cursor-secret-1234567890",
  );
  const detail = await reopened.detail(git(), review.id);
  expect(detail.outdated).toBe(false);
  expect(detail.files).toEqual([
    { path: "app.forge", before: "purpose Before", after: "purpose After" },
  ]);
  expect(detail.comments.items[0].body).toBe("Looks good");
  expect(
    (await studio.decide(git(), review.id, "approve", review.version)).status,
  ).toBe("Approved");
  await expect(
    studio.decide(git(), review.id, "close", review.version),
  ).rejects.toMatchObject({ status: 412 });
});
it.each(["main", "change"])(
  "blocks decisions when %s moves but allows closing",
  async (branch) => {
    const { studio, git, heads, submit } = setup();
    const review = await submit();
    heads[branch] = "c".repeat(40);
    expect((await studio.detail(git(), review.id)).outdated).toBe(true);
    await expect(
      studio.decide(git(), review.id, "approve", review.version),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await studio.decide(git(), review.id, "close", review.version)).status,
    ).toBe("Closed");
  },
);
it("rejects stale submission, cross-repository access, and changed repository configuration", async () => {
  const { studio, git, submit, heads } = setup();
  const review = await submit();
  await expect(
    studio.review(git("main", "other"), review.id),
  ).rejects.toMatchObject({ status: 404 });
  const changed = git();
  changed.project.repository = "owner/other";
  await expect(studio.repository(changed)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    studio.submit(git(), {
      title: "Old",
      description: "",
      baseBranch: "main",
      headBranch: "change",
      headRevision: "c".repeat(40),
    }),
  ).rejects.toMatchObject({ status: 409 });
  heads.change = heads.main!;
  await expect(submit()).rejects.toMatchObject({ status: 400 });
});
it("records immutable artifact provenance and supports requesting changes", async () => {
  const { studio, git, submit } = setup();
  const repo = await studio.repository(git());
  const artifact = await studio.call("IRArtifact", "create", {
    key: "artifact",
    repository: repo.id,
    revision: "a".repeat(40),
    digest: "sha256:" + "b".repeat(64),
    location: "oci://registry.test/app",
    byteCount: 100,
    compilerVersion: "1",
    irVersion: "1",
  });
  await expect(
    studio.call("IRArtifact", "update", {
      id: artifact.id,
      expectedVersion: artifact.version,
      patch: { revision: "c".repeat(40) },
    }),
  ).rejects.toBeDefined();
  expect((await studio.list(git(), "IRArtifact")).items[0].revision).toBe(
    "a".repeat(40),
  );
  const review = await submit();
  expect(
    (await studio.decide(git(), review.id, "requestChanges", review.version))
      .status,
  ).toBe("ChangesRequested");
});

it("exposes authenticated internal review APIs and rejects cross-origin writes", async () => {
  const { createApi } = await import("../src/api.js");
  const { SqliteState } = await import("../src/sqlite.js");
  const { studio, git, db } = setup();
  const token = "a-long-test-administrator-token-1234567890";
  const api = createApi({
    store: new SqliteState(db),
    token,
    authority: "local.test",
    name: "Test",
    runtime: "node",
    registry: null,
    studio,
    git: [git()],
  });
  const call = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ) =>
    api(
      new Request("http://localhost/api/git/projects/demo" + path, {
        method: body ? "POST" : "GET",
        headers: { ...headers, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  expect((await call("/reviews", undefined, {})).status).toBe(401);
  const input = {
    title: "Review",
    description: "",
    baseBranch: "main",
    headBranch: "change",
    headRevision: "b".repeat(40),
  };
  expect(
    (
      await call("/reviews", input, {
        authorization: `Bearer ${token}`,
        origin: "https://elsewhere.test",
      })
    ).status,
  ).toBe(403);
  const created = await call("/reviews", input);
  expect(created.status).toBe(201);
  const review = await created.json();
  expect(
    (await call("/reviews/" + review.id + "/comments", { body: "Ship it" }))
      .status,
  ).toBe(201);
  expect(
    (await (await call("/reviews/" + review.id)).json()).comments.items,
  ).toHaveLength(1);
  expect(
    (
      await call("/reviews/" + review.id + "/decisions", {
        action: "approve",
        expectedVersion: review.version,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/reviews/" + review.id + "/decisions", {
        action: "close",
        expectedVersion: review.version,
      })
    ).status,
  ).toBe(412);
  expect((await call("/reviews/" + review.id + "/comments")).status).toBe(404);
  expect((await call("/branches/not-a-route")).status).toBe(404);
  expect(
    (
      await call("/artifacts", {
        revision: "a".repeat(40),
        digest: "sha256:" + "c".repeat(64),
        location: "https://artifacts.test/app",
        byteCount: 12,
        compilerVersion: "1",
        irVersion: "1",
      })
    ).status,
  ).toBe(201);
  expect((await (await call("/artifacts")).json()).items).toHaveLength(1);
});
