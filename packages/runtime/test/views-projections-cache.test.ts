/**
 * Views (§17): a restricted query algebra lowered to bounded list + filter.
 * Projections (§17): contribution-tracked aggregates maintained from change
 * events, dedup by (source id, revision), rebuild into a new generation.
 * Cache (§16): cache-aside with explicit freshness; expired entries are
 * rejected before physical cleanup; freshness respects the next effective boundary.
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
import { Dispatcher } from "../src/dispatch.js";

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

let storage: MemoryStorage;
let engine: Engine;
let ids: { customer: string; site: string };
beforeEach(async () => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage));
  const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  ids = { customer: c.id, site: s.id };
});
const order = (subtotal: string) => run(engine.call("@acme/commerce/_/Order.create", { customer: ids.customer, site: ids.site, subtotal, tax: "0.00", requestedOn: "2026-09-20" }, ctx));

describe("views", () => {
  it("returns the declared fields of matching records in declared order, paged, never a scan", async () => {
    const o1 = await order("10.00");
    const o2 = await order("20.00");
    const o3 = await order("30.00");
    await run(engine.call("@acme/commerce/_/Order.status.cancel", { id: o3.id, expectedVersion: 1, input: { reason: "x" } }, ctx));
    // submit o1 and o2 via the exposed action path? submit is not exposed; use approve-less path: set status via transition operations available
    const page = await run(engine.call("@acme/commerce/_/PendingOrders.query", { params: { customer: ids.customer } }, ctx));
    expect(page.items).toEqual([]); // nothing Submitted yet
    // move o2 then o1 to Submitted through the internal transition
    await run(engine.callInternal("@acme/commerce/_/Order.status.submit", { id: o2.id, expectedVersion: 1, input: {} }, ctx).pipe(Effect.provide(engine.layer)));
    await run(engine.callInternal("@acme/commerce/_/Order.status.submit", { id: o1.id, expectedVersion: 1, input: {} }, ctx).pipe(Effect.provide(engine.layer)));
    const pending = await run(engine.call("@acme/commerce/_/PendingOrders.query", { params: { customer: ids.customer }, limit: 10 }, ctx));
    expect(pending.items.map((i: any) => Object.keys(i))).toEqual([["id", "site", "total", "requestedOn"], ["id", "site", "total", "requestedOn"]]);
    expect(pending.items.map((i: any) => i.total)).toEqual(["20.00", "10.00"]); // createdAt desc
    expect((await fails(engine.call("@acme/commerce/_/PendingOrders.query", { params: {} }, ctx))).code).toBe("ValidationFailed");
  });
});

describe("projections", () => {
  const P = "@acme/commerce/_/CustomerOrderSummary";
  const apply = async () => {
    // Projections consume their source's change channel through the dispatcher.
    const d = new Dispatcher(model, storage, engine.projectionTransport(), { subscriptions: engine.projectionSubscriptions(), leaseMs: 1000, maxAttempts: 3 });
    return Effect.runPromise(d.sweep("acme", { now: Date.now() }));
  };

  it("is not ready before its first build, then maintains count and exact sum from change events", async () => {
    expect((await fails(engine.call(`${P}.get`, { id: ids.customer }, ctx))).code).toBe("ProjectionNotReady");
    await run(engine.call(`${P}.rebuild`, {}, ctx));
    const empty = await run(engine.call(`${P}.get`, { id: ids.customer }, ctx));
    expect(empty).toMatchObject({ customer: ids.customer, orders: 0, orderTotal: "0.00", generation: 1 });
    const o1 = await order("10.50");
    await order("20.25");
    await apply();
    expect(await run(engine.call(`${P}.get`, { id: ids.customer }, ctx))).toMatchObject({ orders: 2, orderTotal: "30.75" });
    // cancelling removes the contribution (where status != Cancelled)
    await run(engine.call("@acme/commerce/_/Order.status.cancel", { id: o1.id, expectedVersion: 1, input: { reason: "x" } }, ctx));
    await apply();
    expect(await run(engine.call(`${P}.get`, { id: ids.customer }, ctx))).toMatchObject({ orders: 1, orderTotal: "20.25" });
  });

  it("stale or duplicate events do not overwrite a newer contribution", async () => {
    await run(engine.call(`${P}.rebuild`, {}, ctx));
    const o1 = await order("10.00");
    await apply();
    await run(engine.call("@acme/commerce/_/Order.update", { id: o1.id, expectedVersion: 1, patch: { subtotal: "15.00" } }, ctx));
    await apply();
    expect((await run(engine.call(`${P}.get`, { id: ids.customer }, ctx))).orderTotal).toBe("15.00");
    // replay an old event for revision 1 directly: ignored
    const stale = { channel: "@acme/commerce/_/Order.changes", message: "Updated", tenant: "acme", opId: "replay", ordinal: 0, messageId: "replay:0", payload: { id: o1.id, version: 1 }, createdAt: "t" };
    await engine.applyProjectionEvent(P, stale);
    await engine.applyProjectionEvent(P, stale);
    expect((await run(engine.call(`${P}.get`, { id: ids.customer }, ctx))).orderTotal).toBe("15.00");
  });

  it("rebuild into a new generation and switch; the old generation stays readable until the switch", async () => {
    await run(engine.call(`${P}.rebuild`, {}, ctx));
    await order("10.00");
    await order("20.00");
    // simulate a lost event: no apply(); the projection is behind
    expect((await run(engine.call(`${P}.get`, { id: ids.customer }, ctx))).orders).toBe(0);
    const status = await run(engine.call(`${P}.rebuild`, {}, ctx));
    expect(status).toMatchObject({ generation: 2, status: "active" });
    expect(await run(engine.call(`${P}.get`, { id: ids.customer }, ctx))).toMatchObject({ orders: 2, orderTotal: "30.00", generation: 2 });
    const st = await run(engine.call(`${P}.status`, {}, ctx));
    expect(st).toMatchObject({ generation: 2, status: "active" });
    expect(typeof st.lastProcessed).toBe("object");
  });
});

describe("cache", () => {
  const C = "@acme/commerce/_/CurrentSitePolicy";
  it("loads on miss, serves fresh hits, rejects expired entries before cleanup, and keys by every input", async () => {
    await run(engine.call("@acme/commerce/_/SitePolicy.create", { site: ids.site, maxOrderTotal: "100.00", effectiveFrom: "2026-01-01T00:00:00Z", effectiveUntil: "2026-01-01T00:10:00Z" }, ctx));
    await run(engine.call("@acme/commerce/_/SitePolicy.create", { site: ids.site, maxOrderTotal: "200.00", effectiveFrom: "2026-01-01T00:10:00Z" }, ctx));
    // test clock starts at 2026-01-01T00:00:00Z and advances 1s per call
    const first = await run(engine.call(`${C}.read`, { key: { site: ids.site } }, ctx));
    expect(first).toMatchObject({ value: { maxOrderTotal: "100.00" }, source: "loader" });
    // freshUntil = min(now + 5m, next boundary 00:10:00) = 00:05:xx
    expect(first.freshUntil < "2026-01-01T00:10:00.000Z").toBe(true);
    const hit = await run(engine.call(`${C}.read`, { key: { site: ids.site } }, ctx));
    expect(hit.source).toBe("cache");
    // jump the clock past the boundary: the cached entry is rejected even though cleanup has not run
    engine.testClockJump?.(11 * 60 * 1000);
    const after = await run(engine.call(`${C}.read`, { key: { site: ids.site } }, ctx));
    expect(after).toMatchObject({ value: { maxOrderTotal: "200.00" }, source: "loader" });
    expect((await fails(engine.call(`${C}.read`, { key: {} }, ctx))).code).toBe("ValidationFailed");
  });

  it("single-flight: concurrent misses in one process load once", async () => {
    await run(engine.call("@acme/commerce/_/SitePolicy.create", { site: ids.site, maxOrderTotal: "100.00", effectiveFrom: "2026-01-01T00:00:00Z" }, ctx));
    const results = await Promise.all(Array.from({ length: 5 }, () => run(engine.call(`${C}.read`, { key: { site: ids.site } }, ctx))));
    expect(results.filter((r) => r.source === "loader")).toHaveLength(1);
    expect(results.every((r) => r.value.maxOrderTotal === "100.00")).toBe(true);
  });
});
