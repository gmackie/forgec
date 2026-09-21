import { expect, it } from "vitest";
import { GitRepository } from "../src/git.js";
const sha = "a".repeat(40);
const config = {
  id: "demo",
  name: "Desk",
  repository: "owner/repo",
  branch: "studio",
  root: "app/src",
};
it("commits only changed Forge files with an atomic expected-head check", async () => {
  const calls: { url: string; body: any }[] = [];
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("/git/trees/"))
      return Response.json({
        tree: [
          {
            path: "app/src/a.forge",
            type: "blob",
            mode: "100644",
            sha: "b".repeat(40),
            size: 20,
          },
          { path: "README.md", type: "blob", sha: "c".repeat(40) },
        ],
      });
    if (url.includes("/git/blobs/"))
      return Response.json({
        encoding: "base64",
        content: btoa("purpose Original\n"),
      });
    if (url.endsWith("/graphql"))
      return Response.json({
        data: {
          createCommitOnBranch: {
            commit: {
              oid: "d".repeat(40),
              url: "https://github.com/owner/repo/commit/d",
            },
          },
        },
      });
    throw Error(`Unexpected ${url}`);
  };
  const git = new GitRepository(
    config,
    "private-token",
    request as typeof fetch,
  );
  const result = await git.commit({
    base: sha,
    message: "Change purpose",
    files: [{ path: "a.forge", text: "purpose Updated\n" }],
  });
  const input = calls.at(-1)!.body.variables.input;
  expect(input.expectedHeadOid).toBe(sha);
  expect(input.branch).toEqual({
    repositoryNameWithOwner: "owner/repo",
    branchName: "studio",
  });
  expect(input.fileChanges).toEqual({
    additions: [
      { path: "app/src/a.forge", contents: btoa("purpose Updated\n") },
    ],
    deletions: [],
  });
  expect(result.revision).toBe("d".repeat(40));
  expect(JSON.stringify(result)).not.toContain("private-token");
});
it("rejects path escapes before contacting Git", async () => {
  let requests = 0;
  const git = new GitRepository(config, "secret", (async () => {
    requests++;
    return Response.json({});
  }) as typeof fetch);
  await expect(
    git.commit({
      base: sha,
      message: "Unsafe",
      files: [{ path: "../secret.forge", text: "purpose X" }],
    }),
  ).rejects.toThrow("relative");
  expect(requests).toBe(0);
});
it("reports a branch conflict without returning a successful commit", async () => {
  const request = async (input: string | URL | Request) =>
    String(input).includes("/git/trees/")
      ? Response.json({ tree: [] })
      : Response.json({
          errors: [
            {
              type: "UNPROCESSABLE",
              message: "expectedHeadOid does not match",
            },
          ],
        });
  const git = new GitRepository(config, "secret", request as typeof fetch);
  await expect(
    git.commit({
      base: sha,
      message: "Change",
      files: [{ path: "new.forge", text: "purpose X" }],
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("refuses truncated trees rather than turning unseen source into deletions", async () => {
  const git = new GitRepository(config, "secret", (async () =>
    Response.json({ truncated: true, tree: [] })) as typeof fetch);
  await expect(git.snapshot(sha)).rejects.toMatchObject({ status: 413 });
});
it("rejects symbolic links in the source directory", async () => {
  const git = new GitRepository(config, "secret", (async () =>
    Response.json({
      tree: [
        { path: "app/src/link.forge", type: "blob", mode: "120000", size: 10 },
      ],
    })) as typeof fetch);
  await expect(git.snapshot(sha)).rejects.toMatchObject({ status: 413 });
});
it("does not invent a revision when the provider fails", async () => {
  const git = new GitRepository(config, "secret", (async () =>
    Response.json({}, { status: 403 })) as typeof fetch);
  await expect(git.snapshot()).rejects.toMatchObject({ status: 502 });
});
