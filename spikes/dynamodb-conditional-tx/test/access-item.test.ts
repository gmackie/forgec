import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCustomer, updateCustomer } from "../src/protocol.js";
import { queryByTier } from "../src/protocol.js";

/** §11.2: strong portable queries use base-table access items maintained in the entity's transaction. */
let T = "";
beforeEach(() => {
  T = `t-${randomUUID().slice(0, 8)}`;
});

describe("strong access items", () => {
  it("a created record is immediately visible to a consistent query on its access partition", async () => {
    await createCustomer({ tenant: T, id: "c1", code: "A", name: "Zed", opId: "op-1", tier: "gold" });
    await createCustomer({ tenant: T, id: "c2", code: "B", name: "Amy", opId: "op-2", tier: "gold" });
    await createCustomer({ tenant: T, id: "c3", code: "C", name: "Bob", opId: "op-3", tier: "standard" });
    const gold = await queryByTier(T, "gold");
    expect(gold.map((r) => [r.id, r.name, r.version])).toEqual([["c2", "Amy", 1], ["c1", "Zed", 1]]);
  });

  it("an update that changes the sort field moves the access item atomically with the entity", async () => {
    await createCustomer({ tenant: T, id: "c1", code: "A", name: "Zed", opId: "op-1", tier: "gold" });
    await createCustomer({ tenant: T, id: "c2", code: "B", name: "Amy", opId: "op-2", tier: "gold" });
    expect(await updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: "Aaron", opId: "op-u" })).toEqual({ ok: true });
    const gold = await queryByTier(T, "gold");
    expect(gold.map((r) => [r.id, r.name, r.version])).toEqual([["c1", "Aaron", 2], ["c2", "Amy", 1]]);
  });

  it("a stale update leaves the access item untouched", async () => {
    await createCustomer({ tenant: T, id: "c1", code: "A", name: "Zed", opId: "op-1", tier: "gold" });
    await updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: "First", opId: "op-u1" });
    const stale = await updateCustomer({ tenant: T, id: "c1", expectedVersion: 1, name: "Stale", opId: "op-u2" });
    expect(stale.ok).toBe(false);
    expect((await queryByTier(T, "gold")).map((r) => [r.name, r.version])).toEqual([["First", 2]]);
  });
});
