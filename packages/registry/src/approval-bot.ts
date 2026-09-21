/**
 * Callee-PR automation (FORGE-063; PAR-133/136). The bot reads an
 * authenticated request artifact, routes it to the callee owner's repository
 * and writes exactly one file under that repository's restricted grants path,
 * keyed so repeated runs update one PR. It links caller and callee PRs by
 * commit/head. It has no execution path: the artifact is data, projected onto
 * known fields only, and the bot's credential can only reach the configured
 * owner repositories and paths.
 */
import { canonical, type TrustPolicy } from "./artifacts.js";
import { digestOf } from "./artifacts.js";
import { requestPayload, verifyRequest, type DependencyRequest } from "./grants.js";

export interface PullRequest {
  number: number;
  key: string;
  branch: string;
  title: string;
  files: Record<string, string>;
  links: Record<string, string>;
  head: string;
  state: "open" | "merged";
  approvals: { group: string; reviewer: string; head: string; at: string; stale: boolean }[];
  mergedInto?: string;
  mergeCommit?: string;
}

export interface RepoHost {
  repo(name: string): { defaultBranch: string; protected: boolean } | undefined;
  openOrUpdate(repo: string, key: string, pr: { branch: string; title: string; files: Record<string, string>; links: Record<string, string> }): { number: number; head: string; updated: boolean };
  get(repo: string, number: number): PullRequest | undefined;
}

/** In-memory host with the semantics the bot and publication rely on (head = digest of files; approvals go stale on change). */
export class MemoryRepoHost implements RepoHost {
  private store = new Map<string, PullRequest[]>();
  constructor(private readonly repos: Record<string, { defaultBranch: string; protected: boolean }>) {}
  repo(name: string) { return this.repos[name]; }
  prs(repo: string): PullRequest[] { return this.store.get(repo) ?? []; }
  openOrUpdate(repo: string, key: string, pr: { branch: string; title: string; files: Record<string, string>; links: Record<string, string> }) {
    if (!this.repos[repo]) throw new Error(`repository ${repo} is not reachable by this credential`);
    const list = this.store.get(repo) ?? [];
    const head = digestOf(canonical(pr.files)).slice(7, 19);
    const existing = list.find((p) => p.key === key && p.state === "open");
    if (existing) {
      const updated = existing.head !== head;
      if (updated) {
        existing.files = pr.files;
        existing.links = pr.links;
        existing.head = head;
        for (const a of existing.approvals) a.stale = a.head !== head;
      }
      return { number: existing.number, head, updated };
    }
    const number = [...this.store.values()].reduce((n, l) => n + l.length, 0) + 1;
    list.push({ number, key, branch: pr.branch, title: pr.title, files: pr.files, links: pr.links, head, state: "open", approvals: [] });
    this.store.set(repo, list);
    return { number, head, updated: false };
  }
  get(repo: string, number: number) { return this.prs(repo).find((p) => p.number === number); }
  approve(repo: string, number: number, a: { group: string; reviewer: string; head: string }) {
    const pr = this.get(repo, number);
    if (!pr) throw new Error(`no PR #${number} in ${repo}`);
    pr.approvals.push({ ...a, at: new Date().toISOString(), stale: a.head !== pr.head });
  }
  merge(repo: string, number: number, m: { into: string; mergeCommit: string }) {
    const pr = this.get(repo, number);
    if (!pr) throw new Error(`no PR #${number} in ${repo}`);
    pr.state = "merged";
    pr.mergedInto = m.into;
    pr.mergeCommit = m.mergeCommit;
  }
}

export interface OwnerConfig { repo: string; grantsPath: string; requiredGroups: string[] }

export class ApprovalBot {
  /** Always empty: the bot has no execution path. Exposed so tests can assert it. */
  readonly executed: never[] = [];
  constructor(private readonly o: { trust: TrustPolicy; repos: RepoHost; owners: Record<string, OwnerConfig> }) {
    for (const [pkg, cfg] of Object.entries(o.owners)) {
      if (!cfg.grantsPath.endsWith("/") || cfg.grantsPath.startsWith("/") || cfg.grantsPath.split("/").some((s) => s === "..")) throw new Error(`owner ${pkg}: grantsPath must be a relative directory inside the repository (got ${cfg.grantsPath})`);
    }
  }

  /** Idempotent: the same caller→callee request updates one PR; a changed request updates its content (approvals go stale). */
  async process(r: DependencyRequest): Promise<{ pr: number; head: string; request: string; updated: boolean; repo: string }> {
    await verifyRequest(r, this.o.trust); // authenticity first; nothing else in the artifact is trusted
    const owner = this.o.owners[r.callee.package];
    if (!owner) throw new Error(`no registered owner for ${r.callee.package}; requests are routed only to configured owner repositories`);
    // The written file is a projection of known fields: unknown keys (hooks, targets, scripts) never land anywhere.
    const payload = requestPayload(r);
    const file = `${owner.grantsPath}${r.caller.package}/${r.digest}.json`;
    if (file.includes("..") || file.startsWith("/")) throw new Error("refusing a path outside the grants directory");
    const key = `dependency:${r.caller.package}->${r.callee.package}`;
    const res = this.o.repos.openOrUpdate(owner.repo, key, {
      branch: `forge/grant/${r.caller.package.replace(/[^A-Za-z0-9]+/g, "-")}`,
      title: `Dependency request: ${r.caller.package} -> ${r.callee.package} (${r.edges.length} edge${r.edges.length === 1 ? "" : "s"})`,
      files: { [file]: canonical({ ...payload, digest: r.digest, signature: r.signature }) + "\n" },
      links: { ...(r.caller.repo ? { callerRepo: r.caller.repo } : {}), callerCommit: r.provenance.commit, callerHead: r.provenance.head },
    });
    return { pr: res.number, head: res.head, request: r.digest, updated: res.updated, repo: owner.repo };
  }
}
