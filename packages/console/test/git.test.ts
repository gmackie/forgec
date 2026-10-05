import { describe, expect, it } from "vitest";
import { ForgejoRepository, GitRepository, gitRepositories } from "../src/git.js";
import { missingConfiguration } from "../src/config.js";
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

it("tracks branch history and creates a branch at a verified commit",async()=>{
  const calls:{url:string;body:any}[]=[];
  const git=new GitRepository(config,"secret",(async(input,init)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body});
    if(url.includes("/branches?"))return Response.json([{name:"studio",commit:{sha},protected:true}]);
    if(url.includes("/commits?"))return Response.json([{sha,commit:{message:"Change",author:{name:"Author",date:"2026-09-22"}},html_url:"https://github.com/owner/repo/commit/"+sha}]);
    if(url.includes("/git/trees/"))return Response.json({tree:[]});
    if(url.endsWith("/git/refs"))return Response.json({});
    throw Error(url);
  }) as typeof fetch);
  expect((await git.branches()).items[0]).toEqual({name:"studio",revision:sha,protected:true});
  expect((await git.onBranch("studio/change").history()).items[0]!.revision).toBe(sha);
  expect(calls.at(-1)!.url).toContain("sha=studio%2Fchange");
  await git.createBranch("studio/change",sha);
  expect(calls.at(-1)!.body).toEqual({ref:"refs/heads/studio/change",sha});
  await expect(git.createBranch("../invalid",sha)).rejects.toMatchObject({status:400});
});

describe("Forgejo", () => {
  const forgejo = { ...config, provider: "forgejo" as const };
  const head = "e".repeat(40);
  function server(options: { head?: string; reject?: number } = {}) {
    const calls: { url: string; method: string; body: any; auth: string | null }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body, auth: new Headers(init?.headers).get("authorization") });
      if (url.includes("/git/refs/heads/"))
        // Forgejo matches by prefix: `studio-old` must not be mistaken for `studio`.
        return Response.json([
          { ref: "refs/heads/studio-old", object: { sha: "f".repeat(40) } },
          { ref: "refs/heads/studio", object: { sha: options.head ?? head } },
        ]);
      // The root is walked one level at a time; only the source subtree is listed recursively.
      if (url.includes(`/git/trees/${head}?`) || url.includes(`/git/trees/${"9".repeat(40)}?`))
        return Response.json({ truncated: true, tree: [{ path: "app", type: "tree", sha: "a".repeat(40) }] });
      if (url.includes(`/git/trees/${"a".repeat(40)}?`))
        return Response.json({ tree: [{ path: "src", type: "tree", sha: "b".repeat(40) }, { path: "README.md", type: "blob", sha: "3".repeat(40) }] });
      if (url.includes(`/git/trees/${"b".repeat(40)}?recursive=1`))
        return Response.json({
          truncated: false,
          tree: [
            { path: "a.forge", type: "blob", mode: "100644", sha: "1".repeat(40), size: 20 },
            { path: "b.forge", type: "blob", mode: "100644", sha: "2".repeat(40), size: 20 },
            { path: "notes.md", type: "blob", mode: "100644", sha: "4".repeat(40), size: 9 },
          ],
        });
      if (url.includes("/git/blobs/"))
        return Response.json({ encoding: "base64", content: btoa(url.includes("1111") ? "purpose A\n" : "purpose B\n") });
      if (url.endsWith("/contents")) {
        if (options.reject) return new Response("conflict", { status: options.reject });
        return Response.json({ commit: { sha: "d".repeat(40), html_url: "https://git.example.com/owner/repo/commit/d" } });
      }
      throw Error(`Unexpected ${url}`);
    };
    return { calls, git: new ForgejoRepository(forgejo, "fj-token", "https://git.example.com", fetcher as typeof fetch) };
  }
  it("commits creates, updates and deletes in one request with base blob shas", async () => {
    const { calls, git } = server();
    expect(await git.head()).toBe(head);
    const result = await git.commit({
      base: head,
      message: "Rework\n\nbody",
      files: [
        { path: "a.forge", text: "purpose A2\n" },
        { path: "c.forge", text: "purpose C\n" },
      ],
    });
    expect(result).toEqual({ revision: "d".repeat(40), url: "https://git.example.com/owner/repo/commit/d" });
    const write = calls.filter((c) => c.method === "POST");
    expect(write).toHaveLength(1);
    expect(write[0]!.url).toBe("https://git.example.com/api/v1/repos/owner/repo/contents");
    expect(write[0]!.auth).toBe("token fj-token");
    expect(write[0]!.body).toMatchObject({ branch: "studio", message: "Rework\n\nbody" });
    expect(write[0]!.body.files).toEqual([
      { operation: "update", path: "app/src/a.forge", sha: "1".repeat(40), content: btoa("purpose A2\n") },
      { operation: "create", path: "app/src/c.forge", content: btoa("purpose C\n") },
      { operation: "delete", path: "app/src/b.forge", sha: "2".repeat(40) },
    ]);
  });
  it("refuses to commit when the branch has moved past the draft's base", async () => {
    const { calls, git } = server({ head: "9".repeat(40) });
    await expect(
      git.commit({ base: head, message: "x", files: [{ path: "a.forge", text: "purpose Z\n" }] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
  it("reports a changed file as a conflict", async () => {
    const { git } = server({ reject: 409 });
    await expect(
      git.commit({ base: head, message: "x", files: [{ path: "a.forge", text: "purpose Z\n" }, { path: "b.forge", text: "purpose B\n" }] }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Your draft is preserved") });
  });
  it("selects the provider per project and requires its credential", () => {
    const projects = JSON.stringify([config, { ...forgejo, id: "fj" }]);
    const repos = gitRepositories({ GIT_PROJECTS_JSON: projects, GITHUB_TOKEN: "gh", FORGEJO_URL: "https://git.example.com/", FORGEJO_TOKEN: "fj" });
    expect(repos.map((r) => r.constructor.name)).toEqual(["GitRepository", "ForgejoRepository"]);
    expect(() => gitRepositories({ GIT_PROJECTS_JSON: projects, GITHUB_TOKEN: "gh" })).toThrow("FORGEJO_TOKEN");
    expect(() => gitRepositories({ GIT_PROJECTS_JSON: JSON.stringify([forgejo]), FORGEJO_URL: "http://git.example.com", FORGEJO_TOKEN: "fj" })).toThrow("https");
    // A Forgejo-only instance needs no GitHub token.
    expect(gitRepositories({ GIT_PROJECTS_JSON: JSON.stringify([forgejo]), FORGEJO_URL: "https://git.example.com", FORGEJO_TOKEN: "fj" })).toHaveLength(1);
    const base = { INSTANCE_AUTHORITY: "x", ADMIN_TOKEN: "t".repeat(32) };
    expect(missingConfiguration({ ...base, GIT_PROJECTS_JSON: JSON.stringify([forgejo]) })).toEqual(["FORGEJO_URL", "FORGEJO_TOKEN"]);
    expect(missingConfiguration({ ...base, GIT_PROJECTS_JSON: JSON.stringify([config]) })).toEqual(["GITHUB_TOKEN"]);
    expect(missingConfiguration(base)).toEqual([]);
  });
});
