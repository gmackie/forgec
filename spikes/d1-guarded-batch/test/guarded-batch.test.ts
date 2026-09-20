import { beforeEach, describe, expect, it } from "vitest";
import { spike, type Variant } from "./client.js";

const T = "acme";
const observed: Record<string, unknown> = {};

beforeEach(async () => {
  await spike.reset();
  await spike.seed(T, "c1", "Initial");
});

describe.each<Variant>(["predicate-first", "changes-after"])("guarded update (%s)", (variant) => {
  it("commits record, audit and outbox when the expected version matches", async () => {
    const r = await spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: "Renamed", opId: "op-ok", variant });
    expect(r.ok).toBe(true);
    expect(r.rowsChanged).toBe(1);

    const d = await spike.dump(T);
    expect(d.customer).toEqual([{ tenant: T, id: "c1", version: 2, name: "Renamed" }]);
    expect(d.audit.map((a) => a["op_id"])).toEqual(["op-ok"]);
    expect(d.outbox.map((o) => o["op_id"])).toEqual(["op-ok"]);
    expect(d.asserts).toEqual([]);
  });

  it("aborts the whole batch on a stale expected version: no audit, no outbox, no leftover assertion", async () => {
    await spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: "First", opId: "op-1", variant });
    const stale = await spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: "Stale", opId: "op-stale", variant });
    observed[`stale-error:${variant}`] = stale.error;

    expect(stale.ok).toBe(false);
    expect(stale.outcome).toBe("VersionConflict");

    const d = await spike.dump(T);
    expect(d.customer).toEqual([{ tenant: T, id: "c1", version: 2, name: "First" }]);
    expect(d.audit.map((a) => a["op_id"])).toEqual(["op-1"]);
    expect(d.outbox.map((o) => o["op_id"])).toEqual(["op-1"]);
    expect(d.asserts).toEqual([]);
  });

  it("admits exactly one winner among concurrent updates with the same expected version", async () => {
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: `W${i}`, opId: `race-${i}`, variant }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);
    expect(new Set(losers.map((l) => l.outcome))).toEqual(new Set(["VersionConflict"]));

    const d = await spike.dump(T);
    expect(d.customer[0]?.["version"]).toBe(2);
    expect(d.audit).toHaveLength(1);
    expect(d.outbox).toHaveLength(1);
    expect(d.asserts).toEqual([]);
  });
});

describe("control: unguarded batch", () => {
  it("documents the hazard: a stale update still writes audit and outbox", async () => {
    await spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: "First", opId: "op-1", variant: "unguarded" });
    const stale = await spike.update({ tenant: T, id: "c1", expectedVersion: 1, name: "Stale", opId: "op-stale", variant: "unguarded" });
    expect(stale.ok).toBe(true);
    expect(stale.rowsChanged).toBe(0);

    const d = await spike.dump(T);
    expect(d.customer[0]?.["name"]).toBe("First");
    // This is the bug the guard exists to prevent.
    expect(d.audit.map((a) => a["op_id"])).toEqual(["op-1", "op-stale"]);
    expect(d.outbox.map((o) => o["op_id"])).toEqual(["op-1", "op-stale"]);
  });
});

describe("batch atomicity", () => {
  it("rolls back statements that ran before a failing CHECK in the same batch", async () => {
    const r = await spike.rollbackProof(T, "proof-1");
    observed["rollback-error"] = r.error;
    expect(r.ok).toBe(false);
    const d = await spike.dump(T);
    expect(d.audit).toEqual([]);
    expect(d.asserts).toEqual([]);
  });

  it("prints the observed provider error shapes", () => {
    // Not an assertion: evidence for the adapter's error-translation design.
    console.log(JSON.stringify(observed, null, 2));
  });
});
