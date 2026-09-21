/**
 * M21 (PAR-173, PAR-175): mixed-version rollouts and the supply-chain
 * adversarial suite. Old queued work and old cached authority cannot bypass
 * current revocation or reinterpret responses under a newer surface;
 * tampered packages, registry responses, grant artifacts and request
 * overlays never execute code, leak credentials or activate anything.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { localAuthorizer, type AppBundle, type Policy } from "@forgegraph/runtime";
import { MemoryArtifactStore, Registry, generateSigner } from "../src/artifacts.js";
import { ApprovalBot, MemoryRepoHost } from "../src/approval-bot.js";
import { publishGrant } from "../src/grant-publication.js";
import { GrantRegistry, guardExternals, requestFrom, signRequest } from "../src/grants.js";
import { SnapshotHolder, SnapshotPublisher, withSnapshotAuthority } from "../src/snapshots.js";

const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("PAR-173: mixed-version security deployment", () => {
  it("old queued work under a revoked grant, a stale snapshot epoch and an old cached allow are all refused; new requests under the new surface work", async () => {
    const release = await generateSigner("release");
    const policy = await generateSigner("policy");
    const trust = { authority: "registry.acme", signers: { release: release.publicKey, policy: policy.publicKey } };
    // v1 deployment: grant activated, snapshot epoch 1 valid
    const grants = new GrantRegistry({ trust });
    const edge = { caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge" };
    const g = await grants.testGrant(edge, release);
    await grants.admit(g);
    await grants.activate(g.digest, { identity: edge.caller, epoch: 1, snapshotAck: true });
    let now = Date.parse("2026-09-21T10:00:00Z");
    const holder = new SnapshotHolder({ trust, onExpiry: "deny", graceMs: 0 });
    const publisher = new SnapshotPublisher({ authority: "registry.acme", signer: policy });
    const policies: Policy[] = [{ id: "all", actions: ["@t/_/Thing.*"], requires: [], where: [] }];
    await holder.activate(await publisher.full({ epoch: 1, issuedAt: "2026-09-21T09:00:00Z", expiresAt: "2026-09-21T11:00:00Z", policies, catalog: { packages: [] } }));
    const authorizer = withSnapshotAuthority((held) => localAuthorizer({ policies: held.policies, pips: [], epoch: held.epoch, knownObligations: [] }), holder, () => now);
    const req = { principal: { tenant: "t", actor: "a" }, action: "@t/_/Thing.get", kind: "read", attributes: [], requestId: "old" };
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("allow");
    let calls = 0;
    const externals = guardExternals({ [edge.callee]: async () => { calls++; return { ok: true, value: {} }; } }, grants, { identity: edge.caller, epoch: () => 1 });
    expect((await externals[edge.callee]!({}, { tenant: "t", actor: "a", requestId: "q1", purpose: edge.purpose })).ok).toBe(true);
    // rollout of v2: the grant is emergency-revoked and a new snapshot (epoch 2) narrows the policy to reads
    const revoked = grants.emergencyRevoke(g.digest, { reason: "rotate", at: "2026-09-21T10:05:00Z", boundMs: 60_000 });
    await holder.activate(await publisher.incremental({ epoch: 2, base: 1, issuedAt: "2026-09-21T10:05:00Z", expiresAt: "2026-09-21T12:00:00Z", policies: [{ id: "reads", actions: ["@t/_/Thing.get"], requires: [], where: [] }] }));
    // queued old work (still carrying epoch 1) is delivered now: refused, the adapter never runs
    const stale = guardExternals({ [edge.callee]: async () => { calls++; return { ok: true, value: {} }; } }, grants, { identity: edge.caller, epoch: () => 1 });
    const late = await stale[edge.callee]!({}, { tenant: "t", actor: "a", requestId: "q-old", purpose: edge.purpose });
    expect(late).toMatchObject({ ok: false, code: "NotPermitted", detail: expect.stringMatching(/revoked/) });
    expect(calls).toBe(1);
    // a new request on the new epoch is also refused for the revoked edge (revocation is not epoch-scoped)
    expect(grants.verify({ ...edge, epoch: revoked.epoch }).allowed).toBe(false);
    // the old cached allow under epoch 1 cannot be replayed: the authorizer's epoch moved, the write policy is gone
    expect(authorizer.epoch).toBe(2);
    expect((await Effect.runPromise(authorizer.decide({ ...req, action: "@t/_/Thing.update", kind: "write" }))).effect).toBe("deny");
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("allow"); // reads continue under the narrowed policy
    // a response shaped for the old surface is not reinterpreted: the snapshot's policy set is what decides
    now = Date.parse("2026-09-21T12:30:00Z"); // epoch 2 expired and no epoch 3 arrived
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("deny");
  });
});

describe("PAR-175: supply-chain and CI adversarial suite", () => {
  it("tampered packages, registry responses, request overlays and grant artifacts never execute, leak or activate", async () => {
    const ci = await generateSigner("acme-ci");
    const release = await generateSigner("release");
    const rogue = await generateSigner("rogue");
    const trust = { authority: "registry.acme", signers: { "acme-ci": ci.publicKey, release: release.publicKey } };
    // 1. a registry response with a swapped layer is refused before anything is returned
    const registry = new Registry({ authority: "registry.acme", store: new MemoryArtifactStore(), trust });
    const pub = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle: acme, provenance: { builder: "ci", commit: "c", built_at: "2026-09-21T00:00:00Z" }, signer: release });
    const store = registry.store as MemoryArtifactStore;
    const evil = { ...acme, ir: { ...acme.ir, modules: acme.ir.modules.map((m) => ({ ...m, functions: m.functions.map((f) => ({ ...f, uses: [...f.uses, { kind: "function", function: "@evil/exfil/_/Send" }] })) })) } };
    store.blobs.set(pub.layers["bundle"]!, JSON.stringify(evil));
    await expect(registry.pull(pub.digest)).rejects.toThrow(/digest mismatch/);
    // 2. a package that ships install hooks is data to the toolchain: nothing runs (the compiler test proves resolution never executes; here the registry stores only allow-listed layers)
    expect(Object.keys(pub.layers).sort()).toEqual(["bundle", "contracts", "ir", "openapi"]);
    // 3. a dependency request overlay that tries to add edges or a target path is projected away and cannot escalate
    const repos = new MemoryRepoHost({ "acme/payments": { defaultBranch: "main", protected: true } });
    const bot = new ApprovalBot({ trust, repos, owners: { "@acme/payments": { repo: "acme/payments", grantsPath: "grants/", requiredGroups: ["payments-owners", "security"] } } });
    const request = requestFrom({ bundle: acme, callee: "@acme/payments", caller: { identity: "acme-prod/commerce", repo: "acme/commerce", environment: "prod", audience: "org:acme", scope: "orders" }, purposes: { "@acme/payments/_/AuthorizePayment": "@acme/payments/_/Charge" }, assurance: "workload-bound", lifetime: { expiresAt: "2027-01-01T00:00:00Z" }, provenance: { ci: "run", commit: "c1", head: "h1" } });
    const signed = await signRequest(request, ci);
    const overlay = { ...signed, edges: [...signed.edges, { kind: "function" as const, callee: "@acme/payments/_/Refund", caller: "@acme/commerce/_/SubmitOrder", purpose: "@acme/payments/_/Charge" }] };
    await expect(bot.process(overlay)).rejects.toThrow(/digest does not match/); // the overlay broke the signature binding
    await expect(bot.process(await signRequest(overlay, rogue))).rejects.toThrow(/not trusted/); // re-signing needs a trusted CI key
    // 4. a forged grant (rogue signer, or altered approvals) is never admitted or activated
    const grants = new GrantRegistry({ trust });
    const pr = await bot.process(signed);
    repos.approve("acme/payments", pr.pr, { group: "payments-owners", reviewer: "pay", head: pr.head });
    repos.approve("acme/payments", pr.pr, { group: "security", reviewer: "sec", head: pr.head });
    repos.merge("acme/payments", pr.pr, { into: "main", mergeCommit: "m" });
    const grant = await publishGrant({ repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: release, trust });
    await expect(grants.admit({ ...grant, edges: [...grant.edges, { kind: "function", callee: "@acme/payments/_/Refund", caller: "x", purpose: "p" }] })).rejects.toThrow(/signature/);
    await expect(publishGrant({ repos, repo: "acme/payments", pr: pr.pr, requiredGroups: ["payments-owners", "security"], signer: rogue, trust })).rejects.toThrow(/not in the trust policy/);
    // an admitted grant is still not access until activated for the deployed identity under an acknowledged snapshot
    await grants.admit(grant);
    expect(grants.verify({ caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge", epoch: 1 }).allowed).toBe(false);
    await expect(grants.activate(grant.digest, { identity: "acme-prod/commerce", epoch: 1, snapshotAck: false })).rejects.toThrow(/acknowledged snapshot/);
    // 5. credentials never leave the trust policy: nothing in any artifact carries a private key or token
    const everything = JSON.stringify({ pub, grant, request: signed, prs: repos.prs("acme/payments") });
    expect(everything).not.toMatch(/"d":|privateKey|BEGIN PRIVATE/);
    expect(JSON.stringify(trust)).not.toMatch(/"d":/); // JWK public keys only
  });
});
