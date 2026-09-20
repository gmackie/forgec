/**
 * Effective dating (plan §18): half-open [from, until), no overlap per
 * uniqueBy group, enforced at commit; `effective(group, at)` is zero-or-one.
 * Hierarchy: same-tenant parent, no self/cycle, restricted delete, bounded
 * traversal, moves never change identity.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, ForgeError, never>) => Effect.runPromise(e);
const fails = async <A>(e: Effect.Effect<A, ForgeError, never>): Promise<ForgeError> => {
  const exit = await Effect.runPromiseExit(e);
  if (exit._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(exit.value));
  const s = Cause.squash(exit.cause);
  if (s instanceof ForgeError) return s;
  throw new Error(Cause.pretty(exit.cause));
};
const P = "@acme/commerce/_/SitePolicy";
const D = "@acme/commerce/_/Department";

let engine: Engine;
let site: string;
let customer: string;
beforeEach(async () => {
  engine = new Engine(model, testLayer(new MemoryStorage()));
  const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  customer = c.id;
  site = s.id;
});

describe("effective dating", () => {
  it("requires from < until, allows adjacent intervals, rejects overlaps within the group", async () => {
    const p1 = await run(engine.call(`${P}.create`, { site, maxOrderTotal: "100.00", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: "2026-02-01T00:00:00Z" }, ctx));
    expect(p1).toMatchObject({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-02-01T00:00:00.000Z" });
    const bad = await fails(engine.call(`${P}.create`, { site, maxOrderTotal: "1.00", effectiveFrom: "2026-03-01T00:00:00Z", effectiveUntil: "2026-03-01T00:00:00Z" }, ctx));
    expect(bad.code).toBe("ValidationFailed");
    expect(bad.fields?.[0]?.code).toBe("EmptyInterval");
    // adjacent: begins exactly at previous end
    await run(engine.call(`${P}.create`, { site, maxOrderTotal: "200.00", effectiveFrom: "2026-02-01T00:00:00Z", effectiveUntil: null }, ctx));
    const overlap = await fails(engine.call(`${P}.create`, { site, maxOrderTotal: "300.00", effectiveFrom: "2026-01-15T00:00:00Z", effectiveUntil: "2026-01-20T00:00:00Z" }, ctx));
    expect(overlap.code).toBe("ValidationFailed");
    expect(overlap.fields?.[0]?.code).toBe("IntervalOverlap");
    expect(overlap.constraint).toBe(`${P}.effective.site`);
    // unbounded future blocks any later interval
    const later = await fails(engine.call(`${P}.create`, { site, maxOrderTotal: "1.00", effectiveFrom: "2027-01-01T00:00:00Z" }, ctx));
    expect(later.fields?.[0]?.code).toBe("IntervalOverlap");
  });

  it("effective(site, at) returns zero-or-one; missing policy is a typed NotFound", async () => {
    await run(engine.call(`${P}.create`, { site, maxOrderTotal: "100.00", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: "2026-02-01T00:00:00Z" }, ctx));
    await run(engine.call(`${P}.create`, { site, maxOrderTotal: "200.00", effectiveFrom: "2026-02-01T00:00:00Z" }, ctx));
    expect((await run(engine.call(`${P}.effective.bySite`, { params: { site, at: "2026-01-31T23:59:59Z" } }, ctx))).maxOrderTotal).toBe("100.00");
    expect((await run(engine.call(`${P}.effective.bySite`, { params: { site, at: "2026-02-01T00:00:00Z" } }, ctx))).maxOrderTotal).toBe("200.00");
    expect((await run(engine.call(`${P}.effective.bySite`, { params: { site, at: "2030-01-01T00:00:00Z" } }, ctx))).maxOrderTotal).toBe("200.00");
    expect((await fails(engine.call(`${P}.effective.bySite`, { params: { site, at: "2025-12-31T00:00:00Z" } }, ctx))).code).toBe("NotFound");
  });

  it("changing an interval re-checks overlap against the group; a different site is a different group", async () => {
    const p1 = await run(engine.call(`${P}.create`, { site, maxOrderTotal: "100.00", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: "2026-02-01T00:00:00Z" }, ctx));
    await run(engine.call(`${P}.create`, { site, maxOrderTotal: "200.00", effectiveFrom: "2026-02-01T00:00:00Z", effectiveUntil: "2026-03-01T00:00:00Z" }, ctx));
    const grow = await fails(engine.call(`${P}.update`, { id: p1.id, expectedVersion: 1, patch: { effectiveUntil: "2026-02-15T00:00:00Z" } }, ctx));
    expect(grow.fields?.[0]?.code).toBe("IntervalOverlap");
    const shrink = await run(engine.call(`${P}.update`, { id: p1.id, expectedVersion: 1, patch: { effectiveUntil: "2026-01-15T00:00:00Z" } }, ctx));
    expect(shrink.version).toBe(2);
    const s2 = await run(engine.call("@acme/commerce/_/Site.create", { customer, code: "b2", name: "B", timezone: "UTC" }, ctx));
    await run(engine.call(`${P}.create`, { site: s2.id, maxOrderTotal: "1.00", effectiveFrom: "2026-01-01T00:00:00Z" }, ctx));
  });
});

describe("hierarchy", () => {
  it("parent must be same tenant and live; move rejects self-parent and cycles; children/ancestors are bounded queries", async () => {
    const root = await run(engine.call(`${D}.create`, { customer, name: "Root" }, ctx));
    expect(root.parent).toBeNull();
    const a = await run(engine.call(`${D}.create`, { customer, name: "A", parent: root.id }, ctx));
    const b = await run(engine.call(`${D}.create`, { customer, name: "B", parent: a.id }, ctx));
    expect((await fails(engine.call(`${D}.create`, { customer, name: "X", parent: "dep_nope" }, ctx))).code).toBe("ReferenceMissing");
    expect((await fails(engine.call(`${D}.move`, { id: a.id, expectedVersion: 1, parent: a.id }, ctx))).code).toBe("ValidationFailed");
    const cycle = await fails(engine.call(`${D}.move`, { id: root.id, expectedVersion: 1, parent: b.id }, ctx));
    expect(cycle.code).toBe("ValidationFailed");
    expect(cycle.fields?.[0]?.code).toBe("Cycle");
    const moved = await run(engine.call(`${D}.move`, { id: b.id, expectedVersion: 1, parent: root.id }, ctx));
    expect(moved).toMatchObject({ id: b.id, parent: root.id, version: 2 });
    const children = await run(engine.call(`${D}.children`, { id: root.id }, ctx));
    expect(children.items.map((c: any) => c.name)).toEqual(["A", "B"]);
    const anc = await run(engine.call(`${D}.ancestors`, { id: b.id }, ctx));
    expect(anc.items.map((c: any) => c.name)).toEqual(["Root"]);
    expect((await fails(engine.call(`${D}.delete`, { id: root.id, expectedVersion: 1 }, ctx))).code).toBe("HasDependents");
    await run(engine.call(`${D}.delete`, { id: b.id, expectedVersion: 2 }, ctx));
    await run(engine.call(`${D}.delete`, { id: a.id, expectedVersion: 1 }, ctx));
    expect((await run(engine.call(`${D}.delete`, { id: root.id, expectedVersion: 1 }, ctx))).id).toBe(root.id);
  });

  it("concurrent moves that would form a cycle admit at most one", async () => {
    const a = await run(engine.call(`${D}.create`, { customer, name: "A" }, ctx));
    const b = await run(engine.call(`${D}.create`, { customer, name: "B" }, ctx));
    const results = await Promise.all([
      Effect.runPromiseExit(engine.call(`${D}.move`, { id: a.id, expectedVersion: 1, parent: b.id }, ctx)),
      Effect.runPromiseExit(engine.call(`${D}.move`, { id: b.id, expectedVersion: 1, parent: a.id }, ctx)),
    ]);
    const wins = results.filter((r) => r._tag === "Success").length;
    expect(wins).toBeLessThanOrEqual(1);
    const [ra, rb] = await Promise.all([run(engine.call(`${D}.get`, { id: a.id }, ctx)), run(engine.call(`${D}.get`, { id: b.id }, ctx))]);
    expect(ra.parent === b.id && rb.parent === a.id).toBe(false);
  });
});
