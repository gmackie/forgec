import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCustomer, createSite, deleteCustomer, getEntity, updateCustomer, type Result } from "../src/protocol.js";
import { dumpTenant } from "../src/table.js";

const observed: Record<string, unknown> = {};
let T = "";

const by = (items: Record<string, unknown>[], sk: string) => items.filter((i) => i["SK"] === sk);
const audits = (items: Record<string, unknown>[]) => by(items, "AUDIT").map((a) => String(a["PK"]).split("#A#")[1]);
const outbox = (items: Record<string, unknown>[]) => items.filter((i) => String(i["SK"]).startsWith("E#")).map((o) => String(o["PK"]).split("#O#")[1]);
const fail = (r: Result) => (r.ok ? undefined : r);

// Each test gets a fresh tenant prefix, so no cleanup is needed between runs.
beforeEach(() => {
  T = `t-${randomUUID().slice(0, 8)}`;
});

describe("create with unique claim", () => {
  it("commits entity, claim, audit and outbox together", async () => {
    const r = await createCustomer({ tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-1" });
    expect(r).toEqual({ ok: true });
    const items = await dumpTenant(T);
    expect(by(items, "ENTITY")).toHaveLength(1);
    expect(by(items, "CLAIM")).toHaveLength(1);
    expect(audits(items)).toEqual(["op-1"]);
    expect(outbox(items)).toEqual(["op-1"]);
  });

  it("admits exactly one winner among concurrent creates claiming the same code", async () => {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => createCustomer({ tenant: T, id: `c${i}`, code: "DUP", name: `N${i}`, opId: `op-${i}` })),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok).map(fail);
    observed["unique-conflict"] = losers[0];
    expect(winners).toHaveLength(1);
    // Losers are either a semantic unique conflict or a retryable transaction conflict — never a partial write.
    for (const l of losers) expect(["UniqueConflict", "TransactionConflict"]).toContain(l!.outcome);
    expect(losers.filter((l) => l!.outcome === "UniqueConflict").length).toBeGreaterThan(0);

    const items = await dumpTenant(T);
    expect(by(items, "ENTITY")).toHaveLength(1);
    expect(by(items, "CLAIM")).toHaveLength(1);
    expect(audits(items)).toHaveLength(1);
    expect(outbox(items)).toHaveLength(1);
  });

  it("rejects a second create of the same id with a different code as AlreadyExists, writing nothing", async () => {
    await createCustomer({ tenant: T, id: "c1", code: "ONE", name: "One", opId: "op-1" });
    const r = fail(await createCustomer({ tenant: T, id: "c1", code: "TWO", name: "Two", opId: "op-2" }));
    expect(r?.outcome).toBe("AlreadyExists");
    const items = await dumpTenant(T);
    expect(by(items, "CLAIM")).toHaveLength(1);
    expect(audits(items)).toEqual(["op-1"]);
  });
});

describe("guarded update", () => {
  beforeEach(async () => {
    await createCustomer({ tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-create" });
  });

  it("commits on a matching version and the new version is strongly readable", async () => {
    expect(await updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: "Renamed", opId: "op-u1" })).toEqual({ ok: true });
    const e = await getEntity(T, "customer", "c1");
    expect(e?.["version"]).toBe(2);
    expect(e?.["name"]).toBe("Renamed");
    const items = await dumpTenant(T);
    expect(audits(items)).toEqual(["op-create", "op-u1"]);
    expect(outbox(items)).toEqual(["op-create", "op-u1"]);
  });

  it("cancels the whole transaction on a stale version: no audit, no outbox", async () => {
    await updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: "First", opId: "op-u1" });
    const r = fail(await updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: "Stale", opId: "op-stale" }));
    observed["version-conflict"] = r;
    expect(r?.outcome).toBe("VersionConflict");
    const e = await getEntity(T, "customer", "c1");
    expect(e?.["name"]).toBe("First");
    const items = await dumpTenant(T);
    expect(audits(items)).toEqual(["op-create", "op-u1"]);
    expect(outbox(items)).toEqual(["op-create", "op-u1"]);
  });

  it("admits exactly one winner among concurrent updates with the same expected version", async () => {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: `W${i}`, opId: `race-${i}` })),
    );
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok).map(fail);
    observed["update-race-outcomes"] = losers.map((l) => l!.outcome);
    expect(winners).toHaveLength(1);
    for (const l of losers) expect(["VersionConflict", "TransactionConflict"]).toContain(l!.outcome);
    const e = await getEntity(T, "customer", "c1");
    expect(e?.["version"]).toBe(2);
    const items = await dumpTenant(T);
    expect(audits(items)).toHaveLength(2);
    expect(outbox(items)).toHaveLength(2);
  });
});

describe("referential integrity guard", () => {
  beforeEach(async () => {
    await createCustomer({ tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-create" });
  });

  it("child create increments the parent's dependents; restrict-delete then fails with HasDependents", async () => {
    expect(await createSite({ tenant: T, customerId: "c1", id: "s1", opId: "op-s1" })).toEqual({ ok: true });
    expect((await getEntity(T, "customer", "c1"))?.["dependents"]).toBe(1);
    const r = fail(await deleteCustomer({ tenant: T, id: "c1", opId: "op-del" }));
    observed["has-dependents"] = r;
    expect(r?.outcome).toBe("HasDependents");
    expect((await getEntity(T, "customer", "c1"))?.["active"]).toBe(true);
  });

  it("child create against a deleted parent fails with ParentUnavailable and writes nothing", async () => {
    expect(await deleteCustomer({ tenant: T, id: "c1", opId: "op-del" })).toEqual({ ok: true });
    const r = fail(await createSite({ tenant: T, customerId: "c1", id: "s1", opId: "op-s1" }));
    observed["parent-unavailable"] = r;
    expect(r?.outcome).toBe("ParentUnavailable");
    expect(await getEntity(T, "site", "s1")).toBeUndefined();
    const items = await dumpTenant(T);
    expect(audits(items)).toEqual(["op-create", "op-del"]);
    expect(fail(await deleteCustomer({ tenant: T, id: "c1", opId: "op-del2" }))?.outcome).toBe("AlreadyDeleted");
  });

  it("parent delete racing child creates never produces an orphan", async () => {
    const N = 6;
    const [del, ...creates] = await Promise.all([
      deleteCustomer({ tenant: T, id: "c1", opId: "op-del" }),
      ...Array.from({ length: N }, (_, i) => createSite({ tenant: T, customerId: "c1", id: `s${i}`, opId: `op-s${i}` })),
    ]);
    const created = creates.filter((r) => r.ok).length;
    const createOutcomes = creates.filter((r) => !r.ok).map((r) => fail(r)!.outcome);
    observed["parent-race"] = { deleteOk: del.ok, deleteOutcome: fail(del)?.outcome, created, createOutcomes };

    const parent = await getEntity(T, "customer", "c1");
    const items = await dumpTenant(T);
    const sites = items.filter((i) => String(i["PK"]).includes("#R#site#") && i["SK"] === "ENTITY");

    // Invariant: sites exist only under a live parent, and the counter equals the live site count.
    expect(sites).toHaveLength(created);
    expect(parent?.["dependents"]).toBe(created);
    if (del.ok) {
      expect(parent?.["active"]).toBe(false);
      expect(sites).toHaveLength(0);
    } else {
      expect(parent?.["active"]).toBe(true);
      expect(["HasDependents", "TransactionConflict"]).toContain(fail(del)!.outcome);
    }
    for (const o of createOutcomes) expect(["ParentUnavailable", "TransactionConflict"]).toContain(o);
    // Only successful creates leave an audit row.
    expect(audits(items).filter((a) => a!.startsWith("op-s"))).toHaveLength(created);
  });
});

describe("client request token", () => {
  it("replaying an identical transaction with the same token succeeds without duplicating effects", async () => {
    const clientToken = randomUUID();
    const cmd = { tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-1", clientToken };
    expect(await createCustomer(cmd)).toEqual({ ok: true });
    const replay = await createCustomer(cmd);
    observed["token-replay"] = replay;
    expect(replay).toEqual({ ok: true });
    const items = await dumpTenant(T);
    expect(by(items, "ENTITY")).toHaveLength(1);
    expect(audits(items)).toEqual(["op-1"]);
  });

  it("the same token with different content is rejected as IdempotentParameterMismatch", async () => {
    const clientToken = randomUUID();
    await createCustomer({ tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-1", clientToken });
    const r = fail(await createCustomer({ tenant: T, id: "c1", code: "ACME", name: "Different", opId: "op-1", clientToken }));
    observed["token-mismatch"] = r;
    expect(r?.outcome).toBe("IdempotentParameterMismatch");
  });

  it("without a token, a replayed create is a semantic AlreadyExists (no native protection)", async () => {
    const cmd = { tenant: T, id: "c1", code: "ACME", name: "Acme", opId: "op-1" };
    await createCustomer(cmd);
    expect(fail(await createCustomer(cmd))?.outcome).toBe("AlreadyExists");
  });
});

describe("evidence", () => {
  it("prints the observed provider error shapes", () => {
    console.log(JSON.stringify(observed, null, 2));
  });
});
