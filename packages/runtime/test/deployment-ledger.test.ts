/**
 * FORGE-069 / PAR-144: a resumable deployment DAG over a durable, fenced
 * ledger. Crash/retry resumes without duplicating completed work or grant
 * activation; a controller that lost its lease cannot advance guarded stages.
 */
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/adapters/memory.js";
import { DeploymentLedger, StaleController } from "../src/deployment-ledger.js";

const plan = { steps: [{ id: "s1-preflight", phase: "preflight", kind: "artifact.verify" }, { id: "s2-expand", phase: "expand", kind: "storage.expand" }, { id: "s3-backfill", phase: "backfill", kind: "data.backfill" }, { id: "s4-verify", phase: "verify", kind: "verify.invariants" }] };
const approval = { artifact: "sha256:" + "a".repeat(64), signedBy: "release", signature: "sig" };

describe("PAR-144: fenced, resumable deployment ledger", () => {
  it("open is idempotent and artifact-bound; completed steps are skipped on resume; grant activation happens once", async () => {
    const ledger = new DeploymentLedger(new MemoryStorage());
    await expect(ledger.open({ rollout: "r1", artifact: "sha256:" + "b".repeat(64), plan, approval })).rejects.toThrow(/artifact-bound/);
    await expect(ledger.open({ rollout: "r1", artifact: approval.artifact, plan: { ...plan, blocked: true }, approval })).rejects.toThrow(/blocked/);
    const doc = await ledger.open({ rollout: "r1", artifact: approval.artifact, plan, approval });
    expect(doc.state).toBe("open");
    expect(await ledger.open({ rollout: "r1", artifact: approval.artifact, plan, approval })).toMatchObject({ rollout: "r1" });
    const token = (await ledger.acquire("r1", "ctl-a", 60_000))!;
    expect(token).toBe(1);
    let runs = 0;
    const first = await ledger.run("r1", "s1-preflight", token, async () => { runs++; return { verified: true }; });
    expect(first).toEqual({ result: { verified: true }, skipped: false });
    // "crash" and retry: the step is done, the action does not run again
    const again = await ledger.run("r1", "s1-preflight", token, async () => { runs++; return { verified: false }; });
    expect(again).toEqual({ result: { verified: true }, skipped: true });
    expect(runs).toBe(1);
    // DAG order is enforced
    await expect(ledger.run("r1", "s3-backfill", token, async () => 1)).rejects.toThrow(/needs s2-expand first/);
    // grant activation once per rollout
    let activations = 0;
    expect(await ledger.activateGrantOnce("r1", token, "grant-1", async () => { activations++; })).toBe(true);
    expect(await ledger.activateGrantOnce("r1", token, "grant-1", async () => { activations++; })).toBe(false);
    expect(activations).toBe(1);
  });

  it("two controllers race: the one that lost its lease cannot record progress; the successor resumes from the checkpoint without repeating items", async () => {
    const ledger = new DeploymentLedger(new MemoryStorage());
    await ledger.open({ rollout: "r2", artifact: approval.artifact, plan, approval });
    let clock = 1_000_000;
    const now = () => clock;
    const a = (await ledger.acquire("r2", "ctl-a", 10_000, now()))!;
    expect(await ledger.acquire("r2", "ctl-b", 10_000, now())).toBeNull(); // A holds the lease
    await ledger.run("r2", "s1-preflight", a, async () => "ok", now);
    await ledger.run("r2", "s2-expand", a, async () => "ok", now);
    const processed: string[] = [];
    // A starts the backfill, checkpoints after each batch, then its lease expires mid-way and B takes over
    const attemptA = ledger.run<string, number>("r2", "s3-backfill", a, async (ctx) => {
      let i = ctx.checkpoint ?? 0;
      while (i < 6) {
        processed.push(`a:${i}`);
        i++;
        if (i === 3) clock += 20_000; // lease expiry while working
        await ctx.save(i); // throws StaleController once the lease is gone
      }
      return "a-done";
    }, now);
    await expect(attemptA).rejects.toBeInstanceOf(StaleController);
    expect(processed).toEqual(["a:0", "a:1", "a:2"]);
    const b = (await ledger.acquire("r2", "ctl-b", 10_000, now()))!;
    expect(b).toBe(a + 1);
    // A's stale token can no longer start or complete anything
    await expect(ledger.run("r2", "s4-verify", a, async () => "x", now)).rejects.toBeInstanceOf(StaleController);
    await expect(ledger.activateGrantOnce("r2", a, "g", async () => undefined, now())).rejects.toBeInstanceOf(StaleController);
    // B resumes the backfill from the last *durable* checkpoint (2): acknowledged batches 0 and 1 are never
    // repeated; batch 2, whose checkpoint A could not record after losing the lease, is re-done (batches are
    // idempotent by contract, and the ledger is what makes "already done" knowable).
    const done = await ledger.run<string, number>("r2", "s3-backfill", b, async (ctx) => {
      let i = ctx.checkpoint ?? 0;
      while (i < 6) {
        processed.push(`b:${i}`);
        i++;
        await ctx.save(i);
      }
      return "b-done";
    }, now);
    expect(done).toEqual({ result: "b-done", skipped: false });
    expect(processed).toEqual(["a:0", "a:1", "a:2", "b:2", "b:3", "b:4", "b:5"]);
    expect(processed.filter((x) => x.endsWith(":0") || x.endsWith(":1"))).toHaveLength(2);
    const status = await ledger.status("r2");
    expect(status.steps["s3-backfill"]).toMatchObject({ status: "done", attempts: 2, by: "ctl-b" });
    await ledger.run("r2", "s4-verify", b, async () => "ok", now);
    await ledger.complete("r2", b, now());
    expect((await ledger.status("r2")).state).toBe("complete");
  });
});
