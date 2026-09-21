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
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, body?: unknown): Promise<any> {
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "Forge-Studio",
        "x-github-api-version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Problem(
        response.status === 404 ? 404 : 502,
        "Git request failed. Check repository access and branch protection.",
      );
    return response.json();
  }
  async snapshot(revision?: string): Promise<GitSnapshot> {
    const base = `/repos/${this.project.repository}`;
    if (!revision) {
      const ref = await this.request(
        `${base}/git/ref/heads/${this.project.branch.split("/").map(encodeURIComponent).join("/")}`,
      );
      revision = ref.object?.sha;
    }
    if (!revision || !/^[a-f0-9]{40}$/.test(revision))
      throw new Problem(502, "Git returned an invalid revision.");
    const tree = await this.request(
      `${base}/git/trees/${revision}?recursive=1`,
    );
    if (tree.truncated)
      throw new Problem(413, "Repository tree is too large to load safely.");
    const prefix = this.project.root ? this.project.root + "/" : "";
    const entries = (tree.tree as any[]).filter(
      (f) => f.path.startsWith(prefix) && f.path.endsWith(".forge"),
    );
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
export function gitRepositories(config: {
  GIT_PROJECTS_JSON?: string;
  GITHUB_TOKEN?: string;
}): GitRepository[] {
  if (!config.GIT_PROJECTS_JSON) return [];
  const projects = z
    .array(gitProjectSchema)
    .max(50)
    .parse(JSON.parse(config.GIT_PROJECTS_JSON));
  if (!config.GITHUB_TOKEN)
    throw new Error("GITHUB_TOKEN is required for configured Git projects.");
  if (new Set(projects.map((p) => p.id)).size !== projects.length)
    throw new Error("Duplicate Git project IDs.");
  return projects.map((p) => new GitRepository(p, config.GITHUB_TOKEN!));
}
