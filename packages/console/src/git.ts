import { z } from "zod";
import { Problem } from "./model.js";
const relative = (path: string) =>
  !!path &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((p) => p && p !== "." && p !== "..");
export const gitProjectSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1).max(120),
    /** Where the repository is hosted. Forgejo uses FORGEJO_URL and FORGEJO_TOKEN. */
    provider: z.enum(["github", "forgejo"]).optional(),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (s) =>
          !/[\s~^:?*\[\\]/.test(s) &&
          !s.includes("..") &&
          !s.includes("@{") &&
          !s.startsWith("/") &&
          !s.endsWith("/"),
      ),
    root: z
      .string()
      .max(300)
      .refine(
        (s) => s === "" || relative(s),
        "Use a relative source directory",
      ),
  })
  .strict();
export type GitProject = z.infer<typeof gitProjectSchema>;
export const gitCommitSchema = z
  .object({
    base: z.string().regex(/^[a-f0-9]{40}$/),
    message: z.string().trim().min(1).max(4000),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .refine(
                (p) => relative(p) && p.endsWith(".forge"),
                "Use a relative .forge path",
              ),
            text: z.string(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .refine(
    (v) => new Set(v.files.map((f) => f.path)).size === v.files.length,
    "Duplicate file path",
  )
  .refine(
    (v) =>
      v.files.reduce(
        (s, f) => s + new TextEncoder().encode(f.text).length,
        0,
      ) <= 500000,
    "Source exceeds 500 KB",
  );
export type GitCommit = z.infer<typeof gitCommitSchema>;
export interface GitSnapshot {
  id: string;
  name: string;
  repository: string;
  branch: string;
  root: string;
  revision: string;
  files: { path: string; text: string }[];
}
const encode = (s: string) => {
  let binary = "";
  for (const b of new TextEncoder().encode(s)) binary += String.fromCharCode(b);
  return btoa(binary);
};
const decode = (s: string) =>
  new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
  );
export class GitRepository {
  constructor(
    readonly project: GitProject,
    protected readonly token: string,
    protected readonly fetcher: typeof fetch = fetch,
  ) {}
  onBranch(branch: string) {
    const parsed=gitProjectSchema.safeParse({...this.project,branch});
    if(!parsed.success)throw new Problem(400,"Enter a valid Git branch name.");
    return this.with(parsed.data);
  }
  protected with(project: GitProject): GitRepository {
    return new GitRepository(project,this.token,this.fetcher);
  }
  async head(): Promise<string> {
    const ref=await this.request(`/repos/${this.project.repository}/git/ref/heads/${this.project.branch.split("/").map(encodeURIComponent).join("/")}`);
    if(!/^[a-f0-9]{40}$/.test(ref.object?.sha || ""))throw new Problem(502,"Git returned an invalid branch revision.");
    return ref.object.sha;
  }
  async branches(page=1): Promise<{items:{name:string;revision:string;protected:boolean}[];hasMore:boolean}> {
    const rows=await this.request(`/repos/${this.project.repository}/branches?per_page=100&page=${page}`);
    if(!Array.isArray(rows))throw new Problem(502,"Git returned an invalid branch list.");
    return {items:rows.map((r:any)=>({name:r.name,revision:r.commit.sha,protected:!!r.protected})),hasMore:rows.length===100};
  }
  async history(page=1): Promise<{items:{revision:string;message:string;url:string;author:string;at:string}[];hasMore:boolean}> {
    const rows=await this.request(`/repos/${this.project.repository}/commits?sha=${encodeURIComponent(this.project.branch)}&per_page=30&page=${page}`);
    if(!Array.isArray(rows))throw new Problem(502,"Git returned an invalid commit list.");
    return {items:rows.map((r:any)=>({revision:r.sha,message:String(r.commit.message).slice(0,4000),url:r.html_url,author:r.commit.author?.name || "Unknown",at:r.commit.author?.date || ""})),hasMore:rows.length===30};
  }
  async createBranch(name: string, revision: string) {
    this.onBranch(name);
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Problem(400,"Invalid base revision.");
    // Resolve the revision through this repository before creating a reference.
    await this.snapshot(revision);
    await this.request(`/repos/${this.project.repository}/git/refs`,{ref:`refs/heads/${name}`,sha:revision});
    return {name,revision};
  }
  protected apiUrl(path: string) {
    return `https://api.github.com${path}`;
  }
  protected headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "Forge-Studio",
      "x-github-api-version": "2022-11-28",
    };
  }
  protected async request(path: string, body?: unknown): Promise<any> {
    const response = await this.fetcher(this.apiUrl(path), {
      method: body ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: this.headers(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Problem(
        response.status === 404 ? 404 : [409, 422].includes(response.status) ? 409 : 502,
        "Git request failed. Check repository access and branch protection.",
      );
    return response.json();
  }
  async snapshot(revision?: string): Promise<GitSnapshot> {
    const base = `/repos/${this.project.repository}`;
    if (!revision) revision = await this.head();
    if (!revision || !/^[a-f0-9]{40}$/.test(revision))
      throw new Problem(502, "Git returned an invalid revision.");
    const entries = await this.forgeEntries(revision);
    const prefix = this.project.root ? this.project.root + "/" : "";
    if (
      entries.length > 50 ||
      entries.some(
        (f) => f.type !== "blob" || !["100644", "100755"].includes(f.mode),
      ) ||
      entries.reduce((s, f) => s + (f.size ?? 500001), 0) > 500000
    )
      throw new Problem(
        413,
        "Git source must contain at most 50 regular Forge files and 500 KB.",
      );
    let bytes = 0;
    const files = [];
    for (const f of entries) {
      const blob = await this.request(`${base}/git/blobs/${f.sha}`);
      if (blob.encoding !== "base64")
        throw new Problem(502, "Git returned unsupported file encoding.");
      const text = decode(blob.content);
      bytes += new TextEncoder().encode(text).length;
      if (bytes > 500000) throw new Problem(413, "Source exceeds 500 KB.");
      files.push({ path: f.path.slice(prefix.length), text });
    }
    return { ...this.project, revision, files };
  }
  /** Tree entries for the `.forge` files under the source root at `revision`. */
  protected async forgeEntries(revision: string): Promise<any[]> {
    const tree = await this.request(
      `/repos/${this.project.repository}/git/trees/${revision}?recursive=1`,
    );
    if (tree.truncated)
      throw new Problem(413, "Repository tree is too large to load safely.");
    const prefix = this.project.root ? this.project.root + "/" : "";
    return (tree.tree as any[]).filter(
      (f) => f.path.startsWith(prefix) && f.path.endsWith(".forge"),
    );
  }
  async commit(input: GitCommit): Promise<{ revision: string; url: string }> {
    const parsed = gitCommitSchema.safeParse(input);
    if (!parsed.success)
      throw new Problem(
        400,
        parsed.error.issues.map((i) => i.message).join("; "),
      );
    const before = await this.snapshot(input.base);
    const prefix = this.project.root ? this.project.root + "/" : "";
    const additions = input.files
      .filter(
        (f) => before.files.find((b) => b.path === f.path)?.text !== f.text,
      )
      .map((f) => ({ path: prefix + f.path, contents: encode(f.text) }));
    const deletions = before.files
      .filter((f) => !input.files.some((n) => n.path === f.path))
      .map((f) => ({ path: prefix + f.path }));
    if (!additions.length && !deletions.length)
      throw new Problem(400, "There are no changes to commit.");
    const [headline, ...rest] = input.message.trim().split("\n");
    const result = await this.request("/graphql", {
      query:
        "mutation ForgeCommit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: this.project.repository,
            branchName: this.project.branch,
          },
          expectedHeadOid: input.base,
          message: { headline, body: rest.join("\n") },
          fileChanges: { additions, deletions },
        },
      },
    });
    if (result.errors?.length)
      throw new Problem(
        409,
        "Git rejected the commit. The branch may have changed or require a pull request. Your draft is preserved; reload the repository to compare changes.",
      );
    const commit = result.data?.createCommitOnBranch?.commit;
    if (!commit?.oid || !/^[a-f0-9]{40}$/.test(commit.oid))
      throw new Problem(
        502,
        "Git did not confirm a commit. Reload the repository before retrying.",
      );
    return { revision: commit.oid, url: commit.url };
  }
}
/**
 * A repository on a Forgejo (or Gitea) instance, such as git.forgegraf.com.
 *
 * Forgejo has no equivalent of GitHub's `expectedHeadOid`, so a commit first checks that the
 * branch is still at the draft's base, then sends every change in one `POST /contents` with
 * the base blob sha of each updated or deleted file. Forgejo rejects the commit if any of those
 * files changed in between; a concurrent commit touching only other files is not detected.
 */
export class ForgejoRepository extends GitRepository {
  constructor(
    project: GitProject,
    token: string,
    private readonly url: string,
    fetcher: typeof fetch = fetch,
  ) {
    super(project, token, fetcher);
  }
  protected with(project: GitProject): GitRepository {
    return new ForgejoRepository(project, this.token, this.url, this.fetcher);
  }
  protected apiUrl(path: string) {
    return `${this.url}/api/v1${path}`;
  }
  protected headers(): Record<string, string> {
    return {
      authorization: `token ${this.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Forge-Studio",
    };
  }
  /**
   * Forgejo pages recursive trees at 1000 entries, which a monorepo exceeds. Walk down to the
   * source root one level at a time and list only that subtree.
   */
  protected async forgeEntries(revision: string): Promise<any[]> {
    const trees = `/repos/${this.project.repository}/git/trees`;
    let sha = revision;
    for (const segment of this.project.root ? this.project.root.split("/") : []) {
      const level = await this.request(`${trees}/${sha}?per_page=1000`);
      const dir = (level.tree as any[]).find((e) => e.path === segment && e.type === "tree");
      if (!dir) {
        if (level.truncated)
          throw new Problem(413, "Repository tree is too large to load safely.");
        return [];
      }
      sha = dir.sha;
    }
    const tree = await this.request(`${trees}/${sha}?recursive=1&per_page=1000`);
    if (tree.truncated)
      throw new Problem(413, "Repository tree is too large to load safely.");
    const prefix = this.project.root ? this.project.root + "/" : "";
    return (tree.tree as any[])
      .filter((f) => f.path.endsWith(".forge"))
      .map((f) => ({ ...f, path: prefix + f.path }));
  }
  async head(): Promise<string> {
    const refs = await this.request(`/repos/${this.project.repository}/git/refs/heads/${this.project.branch.split("/").map(encodeURIComponent).join("/")}`);
    // Forgejo matches refs by prefix, so `main` also returns `main-old`.
    const ref = Array.isArray(refs) ? refs.find((r: any) => r.ref === `refs/heads/${this.project.branch}`) : null;
    if(!/^[a-f0-9]{40}$/.test(ref?.object?.sha || ""))throw new Problem(502,"Git returned an invalid branch revision.");
    return ref.object.sha;
  }
  async branches(page=1) {
    const rows=await this.request(`/repos/${this.project.repository}/branches?limit=50&page=${page}`);
    if(!Array.isArray(rows))throw new Problem(502,"Git returned an invalid branch list.");
    return {items:rows.map((r:any)=>({name:r.name,revision:r.commit.id,protected:!!r.protected})),hasMore:rows.length===50};
  }
  async history(page=1) {
    const rows=await this.request(`/repos/${this.project.repository}/commits?sha=${encodeURIComponent(this.project.branch)}&limit=30&page=${page}&stat=false&verification=false&files=false`);
    if(!Array.isArray(rows))throw new Problem(502,"Git returned an invalid commit list.");
    return {items:rows.map((r:any)=>({revision:r.sha,message:String(r.commit.message).slice(0,4000),url:r.html_url,author:r.commit.author?.name || "Unknown",at:r.commit.author?.date || ""})),hasMore:rows.length===30};
  }
  async createBranch(name: string, revision: string) {
    this.onBranch(name);
    if(!/^[a-f0-9]{40}$/.test(revision))throw new Problem(400,"Invalid base revision.");
    await this.snapshot(revision);
    await this.request(`/repos/${this.project.repository}/branches`,{new_branch_name:name,old_ref_name:revision});
    return {name,revision};
  }
  async commit(input: GitCommit): Promise<{ revision: string; url: string }> {
    const parsed = gitCommitSchema.safeParse(input);
    if (!parsed.success)
      throw new Problem(
        400,
        parsed.error.issues.map((i) => i.message).join("; "),
      );
    const moved = new Problem(
      409,
      "Git rejected the commit. The branch may have changed or require a pull request. Your draft is preserved; reload the repository to compare changes.",
    );
    if ((await this.head()) !== input.base) throw moved;
    const before = await this.snapshot(input.base);
    const prefix = this.project.root ? this.project.root + "/" : "";
    const shas = new Map(
      (await this.forgeEntries(input.base)).map((e) => [e.path, e.sha]),
    );
    const files = [
      ...input.files.flatMap((f) => {
        const old = before.files.find((b) => b.path === f.path);
        if (old?.text === f.text) return [];
        return [
          old
            ? { operation: "update", path: prefix + f.path, sha: shas.get(prefix + f.path), content: encode(f.text) }
            : { operation: "create", path: prefix + f.path, content: encode(f.text) },
        ];
      }),
      ...before.files
        .filter((f) => !input.files.some((n) => n.path === f.path))
        .map((f) => ({ operation: "delete", path: prefix + f.path, sha: shas.get(prefix + f.path) })),
    ];
    if (!files.length) throw new Problem(400, "There are no changes to commit.");
    let result: any;
    try {
      result = await this.request(`/repos/${this.project.repository}/contents`, {
        branch: this.project.branch,
        message: input.message.trim(),
        files,
      });
    } catch (e) {
      if (e instanceof Problem && e.status === 409) throw moved;
      throw e;
    }
    const commit = result?.commit;
    if (!commit?.sha || !/^[a-f0-9]{40}$/.test(commit.sha))
      throw new Problem(
        502,
        "Git did not confirm a commit. Reload the repository before retrying.",
      );
    return { revision: commit.sha, url: commit.html_url };
  }
}
export function gitRepositories(config: {
  GIT_PROJECTS_JSON?: string;
  GITHUB_TOKEN?: string;
  FORGEJO_URL?: string;
  FORGEJO_TOKEN?: string;
}): GitRepository[] {
  if (!config.GIT_PROJECTS_JSON) return [];
  const projects = z
    .array(gitProjectSchema)
    .max(50)
    .parse(JSON.parse(config.GIT_PROJECTS_JSON));
  if (new Set(projects.map((p) => p.id)).size !== projects.length)
    throw new Error("Duplicate Git project IDs.");
  return projects.map((p) => {
    if (p.provider === "forgejo") {
      if (!config.FORGEJO_URL || !config.FORGEJO_TOKEN)
        throw new Error("FORGEJO_URL and FORGEJO_TOKEN are required for Forgejo Git projects.");
      const url = new URL(config.FORGEJO_URL);
      if (url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "" || url.search)
        throw new Error("FORGEJO_URL must be an https origin, e.g. https://git.example.com.");
      return new ForgejoRepository(p, config.FORGEJO_TOKEN, url.origin);
    }
    if (!config.GITHUB_TOKEN)
      throw new Error("GITHUB_TOKEN is required for GitHub Git projects.");
    return new GitRepository(p, config.GITHUB_TOKEN);
  });
}
