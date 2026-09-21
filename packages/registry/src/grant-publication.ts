/**
 * Reviewer requirements and grant publication (FORGE-064; PAR-134/135).
 * A grant is published only from a PR that merged into the repository's
 * protected default branch, whose merged head is the head every counted
 * approval reviewed, with one non-stale approval per required reviewer group
 * from *distinct* reviewers (a person listed under two CODEOWNERS paths is
 * still one reviewer). The result is an immutable, signed grant.
 */
import type { TrustPolicy, Signer } from "./artifacts.js";
import type { RepoHost } from "./approval-bot.js";
import { signGrant, type DependencyGrant, type DependencyRequest } from "./grants.js";

export async function publishGrant(o: { repos: RepoHost; repo: string; pr: number; requiredGroups: string[]; signer: Signer; trust: TrustPolicy; now?: () => string }): Promise<DependencyGrant> {
  const repo = o.repos.repo(o.repo);
  if (!repo) throw new Error(`unknown repository ${o.repo}`);
  const pr = o.repos.get(o.repo, o.pr);
  if (!pr) throw new Error(`no PR #${o.pr} in ${o.repo}`);
  if (pr.state !== "merged") throw new Error(`PR #${o.pr} is not merged`);
  if (!repo.protected || pr.mergedInto !== repo.defaultBranch) throw new Error(`PR #${o.pr} did not merge into the protected default branch ${repo.defaultBranch}`);
  if (!o.trust.signers[o.signer.keyId]) throw new Error(`publication signer ${o.signer.keyId} is not in the trust policy`);
  const counted: DependencyGrant["approvals"] = [];
  const reviewers = new Set<string>();
  for (const group of o.requiredGroups) {
    const fresh = pr.approvals.filter((a) => a.group === group && !a.stale && a.head === pr.head);
    if (fresh.length === 0) {
      const stale = pr.approvals.filter((a) => a.group === group);
      throw new Error(stale.length ? `required reviewer group ${group}: its approval reviewed head ${stale[0]!.head}, which differs from the reviewed head now merged (${pr.head}); the review is stale` : `required reviewer group ${group} has not approved PR #${o.pr}`);
    }
    // an independent check per group: the reviewer must not already have been counted for another group
    const independent = fresh.find((a) => !reviewers.has(a.reviewer));
    if (!independent) throw new Error(`required reviewer groups must be independent: ${fresh[0]!.reviewer} already approved for another group; ${group} needs a different reviewer`);
    reviewers.add(independent.reviewer);
    counted.push({ group, reviewer: independent.reviewer, at: independent.at, head: independent.head });
  }
  const files = Object.entries(pr.files);
  if (files.length !== 1) throw new Error(`PR #${o.pr} must carry exactly one request file, found ${files.length}`);
  const request = JSON.parse(files[0]![1]) as DependencyRequest;
  const grant: DependencyGrant = {
    version: "dependency-grant/1",
    digest: "",
    request: request.digest,
    caller: request.caller,
    callee: request.callee,
    edges: request.edges,
    assurance: request.assurance,
    lifetime: request.lifetime,
    approvals: counted,
    repo: o.repo,
    branch: pr.mergedInto,
    head: pr.head,
    mergeCommit: pr.mergeCommit ?? "",
    publishedAt: (o.now ?? (() => new Date().toISOString()))(),
  };
  return signGrant(grant, o.signer);
}
