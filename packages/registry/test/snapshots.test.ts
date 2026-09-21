/**
 * FORGE-061 / PAR-130: signed incremental snapshots of catalog/policy state
 * let a runtime work without request-time registry lookups; expiry of
 * required security state follows the configured rule and never becomes
 * indefinite stale permission.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { localAuthorizer, type Policy } from "@forge/runtime";
import { generateSigner } from "../src/artifacts.js";
import { SnapshotHolder, SnapshotPublisher, withSnapshotAuthority } from "../src/snapshots.js";

const policies: Policy[] = [{ id: "all", actions: ["@t/_/Thing.*"], requires: [], where: [] }];
const req = { principal: { tenant: "t", actor: "a" }, action: "@t/_/Thing.get", kind: "read", attributes: [], requestId: "r" };

describe("PAR-130: registry offline bounded behavior", () => {
  it("a valid signed snapshot is activated and acknowledged; a tampered or foreign one is not", async () => {
    const signer = await generateSigner("policy");
    const publisher = new SnapshotPublisher({ authority: "registry.acme", signer });
    const holder = new SnapshotHolder({ trust: { authority: "registry.acme", signers: { policy: signer.publicKey } }, onExpiry: "deny" });
    const s1 = await publisher.full({ epoch: 1, issuedAt: "2026-09-20T10:00:00Z", expiresAt: "2026-09-20T11:00:00Z", policies, catalog: { packages: ["registry.acme/@t/x@1.0.0"] } });
    const ack = await holder.activate(s1);
    expect(ack).toMatchObject({ epoch: 1, kind: "full", accepted: true });
    expect(holder.state(Date.parse("2026-09-20T10:30:00Z"))).toEqual({ status: "valid", epoch: 1, expiresAt: "2026-09-20T11:00:00Z" });
    // an incremental snapshot must chain from the active epoch
    const s2 = await publisher.incremental({ epoch: 2, base: 1, issuedAt: "2026-09-20T10:40:00Z", expiresAt: "2026-09-20T11:40:00Z", policies: [{ id: "all", actions: ["@t/_/Thing.get"], requires: [], where: [] }], revoke: ["registry.acme/@t/x@1.0.0"] });
    expect((await holder.activate(s2)).accepted).toBe(true);
    expect(holder.state(Date.parse("2026-09-20T10:41:00Z")).epoch).toBe(2);
    expect(holder.current()!.policies[0]!.actions).toEqual(["@t/_/Thing.get"]);
    expect(holder.current()!.catalog.packages).toEqual([]);
    // gaps and replays are refused
    const s4 = await publisher.incremental({ epoch: 4, base: 3, issuedAt: "2026-09-20T10:50:00Z", expiresAt: "2026-09-20T11:50:00Z", policies: [] });
    expect(await holder.activate(s4)).toMatchObject({ accepted: false, reason: expect.stringMatching(/base epoch 3/) });
    expect(await holder.activate(s1)).toMatchObject({ accepted: false, reason: expect.stringMatching(/older than/) });
    // tampering or a foreign signer never activates
    const tampered = { ...s2, payload: { ...s2.payload, epoch: 9 } };
    expect(await holder.activate(tampered)).toMatchObject({ accepted: false, reason: expect.stringMatching(/signature/) });
    const rogue = new SnapshotPublisher({ authority: "registry.acme", signer: await generateSigner("rogue") });
    expect(await holder.activate(await rogue.full({ epoch: 3, base: 2, issuedAt: "2026-09-20T10:55:00Z", expiresAt: "2026-09-20T11:55:00Z", policies, catalog: { packages: [] } }))).toMatchObject({ accepted: false, reason: expect.stringMatching(/not trusted/) });
  });

  it("with the registry unreachable, operations run on the snapshot until it expires, then follow the rule (deny)", async () => {
    const signer = await generateSigner("policy");
    const publisher = new SnapshotPublisher({ authority: "registry.acme", signer });
    const holder = new SnapshotHolder({ trust: { authority: "registry.acme", signers: { policy: signer.publicKey } }, onExpiry: "deny", graceMs: 5 * 60_000 });
    await holder.activate(await publisher.full({ epoch: 1, issuedAt: "2026-09-20T10:00:00Z", expiresAt: "2026-09-20T11:00:00Z", policies, catalog: { packages: [] } }));
    let now = Date.parse("2026-09-20T10:30:00Z");
    const authorizer = withSnapshotAuthority(localAuthorizer({ policies, pips: [], epoch: 1, knownObligations: [] }), holder, () => now);
    // no registry call is made at request time: the authorizer is a pure function of the held snapshot
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("allow");
    // within the grace window the decision still allows but is marked degraded
    now = Date.parse("2026-09-20T11:02:00Z");
    const grace = await Effect.runPromise(authorizer.decide(req));
    expect(grace.effect).toBe("allow");
    expect(grace.reason).toMatch(/grace/);
    expect(holder.state(now).status).toBe("grace");
    // after the grace window, required authority has expired: deny, with the epoch it expired at
    now = Date.parse("2026-09-20T11:10:00Z");
    const denied = await Effect.runPromise(authorizer.decide(req));
    expect(denied.effect).toBe("deny");
    expect(denied.reason).toMatch(/expired/);
    expect(holder.state(now).status).toBe("expired");
    // the epoch the runtime reports rises past the snapshot epoch so cached allows die with it
    expect(authorizer.epoch).toBeGreaterThan(1);
    // a fresh snapshot restores service
    await holder.activate(await publisher.full({ epoch: 2, issuedAt: "2026-09-20T11:10:00Z", expiresAt: "2026-09-20T12:10:00Z", policies, catalog: { packages: [] } }));
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("allow");
  });

  it("the degrade-readonly rule keeps reads and denies writes after expiry; nothing is indefinite", async () => {
    const signer = await generateSigner("policy");
    const publisher = new SnapshotPublisher({ authority: "registry.acme", signer });
    const holder = new SnapshotHolder({ trust: { authority: "registry.acme", signers: { policy: signer.publicKey } }, onExpiry: "degrade-readonly", graceMs: 0, maxDegradedMs: 60 * 60_000 });
    await holder.activate(await publisher.full({ epoch: 1, issuedAt: "2026-09-20T10:00:00Z", expiresAt: "2026-09-20T11:00:00Z", policies, catalog: { packages: [] } }));
    let now = Date.parse("2026-09-20T11:30:00Z");
    const authorizer = withSnapshotAuthority(localAuthorizer({ policies, pips: [], epoch: 1, knownObligations: [] }), holder, () => now);
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("allow");
    expect((await Effect.runPromise(authorizer.decide({ ...req, action: "@t/_/Thing.update", kind: "write" }))).effect).toBe("deny");
    // even degraded reads end: past maxDegradedMs everything is denied
    now = Date.parse("2026-09-20T12:30:00Z");
    expect((await Effect.runPromise(authorizer.decide(req))).effect).toBe("deny");
  });
});
