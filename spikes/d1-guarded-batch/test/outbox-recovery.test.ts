import { beforeEach, describe, expect, it } from "vitest";
import { spike } from "./client.js";

/**
 * Outbox recovery (plan §14): a committed outbox row must be delivered by a
 * sweeping dispatcher even if the post-commit "nudge" never happens, a
 * dispatcher that crashes mid-delivery must not block the row forever, and a
 * stale dispatcher must not be able to complete a row it no longer leases.
 */
const T = "acme";

beforeEach(async () => {
  await spike.reset();
  await spike.seed(T, "c1", "Initial");
  // A guarded update stages exactly one outbox row for op-1.
  await spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: "First", opId: "op-1", variant: "predicate-first" });
});

describe("outbox sweep and lease", () => {
  it("a committed row with no nudge is found pending by the sweep", async () => {
    const pending = await spike.outboxSweep(T, 1000);
    expect(pending.map((r) => r.op_id)).toEqual(["op-1"]);
  });

  it("claim, deliver, then the row is no longer swept", async () => {
    const claimed = await spike.outboxClaim({ tenant: T, opId: "op-1", ordinal: 0, owner: "d1", now: 1000, leaseMs: 5000 });
    expect(claimed.ok).toBe(true);
    const done = await spike.outboxComplete({ tenant: T, opId: "op-1", ordinal: 0, owner: "d1" });
    expect(done.ok).toBe(true);
    expect(await spike.outboxSweep(T, 1000)).toEqual([]);
    expect(await spike.outboxSweep(T, 999_999)).toEqual([]);
  });

  it("a leased row is invisible to the sweep until the lease expires", async () => {
    await spike.outboxClaim({ tenant: T, opId: "op-1", ordinal: 0, owner: "d1", now: 1000, leaseMs: 5000 });
    expect(await spike.outboxSweep(T, 2000)).toEqual([]);
    expect((await spike.outboxSweep(T, 6001)).map((r) => r.op_id)).toEqual(["op-1"]);
  });

  it("after expiry a new dispatcher reclaims and the stale owner cannot complete (fencing)", async () => {
    await spike.outboxClaim({ tenant: T, opId: "op-1", ordinal: 0, owner: "d1", now: 1000, leaseMs: 5000 });
    const reclaim = await spike.outboxClaim({ tenant: T, opId: "op-1", ordinal: 0, owner: "d2", now: 7000, leaseMs: 5000 });
    expect(reclaim.ok).toBe(true);
    const stale = await spike.outboxComplete({ tenant: T, opId: "op-1", ordinal: 0, owner: "d1" });
    expect(stale.ok).toBe(false);
    const fresh = await spike.outboxComplete({ tenant: T, opId: "op-1", ordinal: 0, owner: "d2" });
    expect(fresh.ok).toBe(true);
    const d = await spike.dump(T);
    expect(d.outbox[0]?.["status"]).toBe("delivered");
    expect(d.outbox[0]?.["attempts"]).toBe(2);
  });

  it("concurrent dispatchers claiming the same row admit exactly one", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        spike.outboxClaim({ tenant: T, opId: "op-1", ordinal: 0, owner: `d${i}`, now: 1000, leaseMs: 5000 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const d = await spike.dump(T);
    expect(d.outbox[0]?.["attempts"]).toBe(1);
  });
});
