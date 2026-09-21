/**
 * FORGE-069/070 / PAR-145: rolling application code back to a version that
 * references a revoked grant does not restore the authority; the current
 * revocation stays authoritative through the deployment ledger's rollback step.
 */
import { describe, expect, it } from "vitest";
import { DeploymentLedger, MemoryStorage } from "@forge/runtime";
import { generateSigner } from "../src/artifacts.js";
import { GrantRegistry } from "../src/grants.js";

describe("PAR-145: rollback cannot restore authority", () => {
  it("the ledger's rollback re-activates only grants the registry has not revoked", async () => {
    const release = await generateSigner("release");
    const trust = { authority: "registry.acme", signers: { release: release.publicKey } };
    const grants = new GrantRegistry({ trust });
    const edge = { caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge" };
    const g1 = await grants.testGrant(edge, release);
    const g2 = await grants.testGrant({ ...edge, callee: "@acme/ledger/_/Post", purpose: "@acme/ledger/_/Settlement" }, release);
    await grants.admit(g1);
    await grants.admit(g2);
    await grants.activate(g1.digest, { identity: edge.caller, epoch: 1, snapshotAck: true });
    await grants.activate(g2.digest, { identity: edge.caller, epoch: 1, snapshotAck: true });
    // incident: g1 is revoked in an emergency
    const revoked = grants.emergencyRevoke(g1.digest, { reason: "compromised", at: new Date().toISOString(), boundMs: 60_000 });
    expect(grants.verify({ ...edge, epoch: revoked.epoch }).allowed).toBe(false);
    // the old application version (v1) declared both grants; operators roll code back to it
    const ledger = new DeploymentLedger(new MemoryStorage());
    const artifact = "sha256:" + "1".repeat(64);
    await ledger.open({ rollout: "rb", artifact, previous: "sha256:" + "0".repeat(64), plan: { steps: [{ id: "s1", phase: "preflight", kind: "artifact.verify" }] }, approval: { artifact, signedBy: "release", signature: "x" } });
    const token = (await ledger.acquire("rb", "ctl", 60_000))!;
    const out = await ledger.rollback("rb", token, {
      grants: [g1.digest, g2.digest],
      authority: { revoked: (d) => grants.isRevoked(d) },
      activate: (d) => grants.activate(d, { identity: edge.caller, epoch: revoked.epoch, snapshotAck: true }),
    });
    expect(out.reactivated).toEqual([g2.digest]);
    expect(out.refused).toEqual([{ grant: g1.digest, reason: expect.stringMatching(/revoked/) }]);
    // even a direct re-activation of the revoked grant changes nothing
    await grants.activate(g1.digest, { identity: edge.caller, epoch: revoked.epoch, snapshotAck: true });
    expect(grants.verify({ ...edge, epoch: revoked.epoch })).toMatchObject({ allowed: false, reason: expect.stringMatching(/revoked/) });
    expect(grants.verify({ caller: edge.caller, callee: "@acme/ledger/_/Post", purpose: "@acme/ledger/_/Settlement", epoch: revoked.epoch }).allowed).toBe(true);
    expect((await ledger.status("rb")).state).toBe("rolled-back");
  });
});
