import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCustomer } from "../src/protocol.js";
import { outboxClaim, outboxComplete, outboxSweep } from "../src/outbox.js";

/** Same contract as the D1 outbox spike; the sweep here reads a sparse GSI. */
let T = "";
const row = () => ({ tenant: T, opId: "op-1", ordinal: 0 });

async function eventually<A>(f: () => Promise<A>, ok: (a: A) => boolean, tries = 20): Promise<A> {
  let last = await f();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 250));
    last = await f();
  }
  return last;
}

beforeEach(async () => {
  T = `t-${randomUUID().slice(0, 8)}`;
  await createCustomer({ tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-1" });
});

describe("outbox sweep (sparse GSI) and lease", () => {
  it("a committed row with no nudge is found pending by the sweep", async () => {
    const pending = await eventually(() => outboxSweep(T, 1000), (p) => p.length > 0);
    expect(pending.map((r) => r.opId)).toEqual(["op-1"]);
  });

  it("claim, deliver, then the row leaves the pending index", async () => {
    await eventually(() => outboxSweep(T, 1000), (p) => p.length > 0);
    expect(await outboxClaim({ ...row(), owner: "d1", now: 1000, leaseMs: 5000 })).toBe(true);
    expect(await outboxComplete({ ...row(), owner: "d1" })).toBe(true);
    const after = await eventually(() => outboxSweep(T, 999_999), (p) => p.length === 0);
    expect(after).toEqual([]);
  });

  it("a leased row is skipped by the sweep until the lease expires", async () => {
    await eventually(() => outboxSweep(T, 1000), (p) => p.length > 0);
    await outboxClaim({ ...row(), owner: "d1", now: 1000, leaseMs: 5000 });
    expect(await outboxSweep(T, 2000)).toEqual([]);
    expect((await outboxSweep(T, 6001)).map((r) => r.opId)).toEqual(["op-1"]);
  });

  it("after expiry a new dispatcher reclaims and the stale owner cannot complete (fencing)", async () => {
    await outboxClaim({ ...row(), owner: "d1", now: 1000, leaseMs: 5000 });
    expect(await outboxClaim({ ...row(), owner: "d2", now: 7000, leaseMs: 5000 })).toBe(true);
    expect(await outboxComplete({ ...row(), owner: "d1" })).toBe(false);
    expect(await outboxComplete({ ...row(), owner: "d2" })).toBe(true);
  });

  it("concurrent dispatchers claiming the same row admit exactly one", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => outboxClaim({ ...row(), owner: `d${i}`, now: 1000, leaseMs: 5000 })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
