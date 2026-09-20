/**
 * Workflows (§15): durable step graph with stable activity ids, signal inbox
 * that closes the early-signal race, timeout/signal races yielding one terminal
 * outcome, idempotent activities across retries, version pinning, and
 * cancellation that never claims to undo completed effects.
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
import { externals, functions } from "../../../examples/acme/impl/index.js";

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

const W = "@acme/commerce/_/ProcessOrder";
let storage: MemoryStorage;
let engine: Engine;
let ids: { customer: string; site: string; order: string };
beforeEach(async () => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage), { functions, externals });
  const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  const o = await run(engine.call("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" }, ctx));
  ids = { customer: c.id, site: s.id, order: o.id };
});
const start = (order = ids.order, key?: string) => run(engine.call(`${W}.start`, { order, expectedVersion: 1 }, key ? { ...ctx, idempotencyKey: key } : ctx));
const get = (id: string) => run(engine.call(`${W}.get`, { id }, ctx));
const signal = (reference: string, amount: string, messageId = `pay:${reference}:${amount}`) =>
  run(engine.call(`${W}.signal`, { message: "PaymentCaptured", messageId, payload: { authorizationId: "auth_1", reference, amount } }, ctx));
const sweep = () => Effect.runPromise(engine.workflows.sweep("acme"));
const order = () => run(engine.call("@acme/commerce/_/Order.get", { id: ids.order }, ctx));

describe("workflow execution", () => {
  it("runs to the first wait, consumes a correlated signal, then sleeps and completes through the sweep", async () => {
    const inst = await start();
    expect(inst).toMatchObject({ workflow: W, version: 1, status: "waiting", waiting: { step: "captured", message: "PaymentCaptured", correlationKey: ids.order } });
    expect((await order()).status).toBe("Submitted"); // the submit activity ran exactly once
    expect(inst.bindings.submit.version).toBe(2);
    const d = await signal(ids.order, "11.00");
    expect(d.delivered).toBe(1);
    const afterSignal = await get(inst.id);
    // choice took the non-short path, approve committed, parallel ran summary then parked on the sleep
    expect(afterSignal).toMatchObject({ status: "sleeping", sleeping: { step: "settle" } });
    expect((await order()).status).toBe("Approved");
    engine.testClockJump(6000);
    await sweep();
    const done = await get(inst.id);
    expect(done).toMatchObject({ status: "completed", output: { id: ids.order, status: "Approved" } });
    expect(done.history.map((h: any) => h.step)).toEqual(["submit", "captured", "short", "approve", "summary", "settle", "return"]);
  });

  it("an early signal is held in the inbox and consumed when the waiter registers; duplicates dedup by messageId", async () => {
    await signal(ids.order, "11.00", "m1");
    await signal(ids.order, "11.00", "m1"); // duplicate delivery
    const inst = await start();
    expect(inst.status).toBe("sleeping"); // the wait was satisfied immediately
    expect(inst.history.filter((h: any) => h.step === "captured")).toHaveLength(1);
  });

  it("duplicate starts with one idempotency key return the same instance", async () => {
    const a = await start(ids.order, "k1");
    const b = await start(ids.order, "k1");
    expect(b.id).toBe(a.id);
    expect((await order()).version).toBe(2);
  });

  it("short payment takes the choice branch: cancel then fail with a declared error", async () => {
    const inst = await start();
    await signal(ids.order, "1.00");
    const st = await get(inst.id);
    expect(st).toMatchObject({ status: "failed", error: { code: `${W}.ShortPayment` } });
    expect((await order()).status).toBe("Cancelled");
  });

  it("a declared callee error is caught into a terminal; an undeclared failure fails the instance with the mapped code", async () => {
    const big = await run(engine.call("@acme/commerce/_/Order.create", { customer: ids.customer, site: ids.site, subtotal: "5000.00", tax: "0.00", requestedOn: "2026-09-20" }, ctx));
    const inst = await start(big.id);
    expect(inst).toMatchObject({ status: "failed", error: { code: `${W}.Declined` } });
    const stale = await run(engine.call(`${W}.start`, { order: ids.order, expectedVersion: 9 }, ctx));
    expect(stale).toMatchObject({ status: "failed", error: { code: "VersionConflict" } });
  });

  it("a signal racing a timeout yields exactly one terminal outcome", async () => {
    const inst = await start();
    engine.testClockJump(3 * 24 * 3600 * 1000);
    await Promise.all([signal(ids.order, "11.00"), sweep()]);
    const st = await get(inst.id);
    const terminal = st.history.filter((h: any) => h.kind === "timeout" || h.kind === "signal");
    expect(terminal).toHaveLength(1);
    expect(["failed", "sleeping", "completed"]).toContain(st.status);
    if (st.status === "failed") expect(st.error.code).toBe(`${W}.PaymentTimeout`);
  });

  it("a retry after a crash between an activity and its receipt does not re-run the activity", async () => {
    engine.workflows.faults.crashAfterStep = "submit";
    const exit = await Effect.runPromiseExit(engine.call(`${W}.start`, { order: ids.order, expectedVersion: 1 }, ctx));
    expect(exit._tag).toBe("Failure");
    engine.workflows.faults.crashAfterStep = null;
    expect((await order()).version).toBe(2);
    // the instance exists in `running` state; advancing it replays the idempotent activity and continues
    const [id] = await Effect.runPromise(engine.workflows.inflight("acme"));
    await sweep();
    const st = await get(id!);
    expect(st.status).toBe("waiting");
    expect((await order()).version).toBe(2); // not resubmitted
  });

  it("two drivers advancing the same instance converge: activities run once, one terminal outcome", async () => {
    const inst = await start();
    await signal(ids.order, "11.00");
    engine.testClockJump(6000);
    // The provider driver, the sweep and a stray HTTP request all race to finish the instance.
    await Promise.all([sweep(), sweep(), Effect.runPromise(engine.workflows.advance("acme", inst.id).pipe(Effect.provide(engine.layer)))]);
    const st = await get(inst.id);
    expect(st.status).toBe("completed");
    expect(st.history.filter((h: any) => h.step === "approve")).toHaveLength(1);
    expect((await order()).version).toBe(3); // submit + approve, never twice
  });

  it("cancellation stops the instance without undoing completed effects", async () => {
    const inst = await start();
    const c = await run(engine.call(`${W}.cancel`, { id: inst.id }, ctx));
    expect(c.status).toBe("cancelled");
    expect((await order()).status).toBe("Submitted");
    expect((await signal(ids.order, "11.00")).delivered).toBe(0);
    expect((await fails(engine.call(`${W}.cancel`, { id: inst.id }, ctx))).code).toBe("InvalidTransition");
  });

  it("in-flight instances are pinned to their version: an incompatible deployment refuses to advance them", async () => {
    const inst = await start();
    const upgraded = structuredClone(bundle);
    for (const m of upgraded.ir.modules) for (const w of m.workflows ?? []) if (w.id === W) { w.version = 2; w.graphHash = "different"; }
    const engine2 = new Engine(new Model(upgraded), testLayer(storage), { functions, externals });
    const r = await run(engine2.call(`${W}.signal`, { message: "PaymentCaptured", messageId: "m9", payload: { authorizationId: "a", reference: ids.order, amount: "11.00" } }, ctx));
    expect(r.delivered).toBe(0);
    expect((await run(engine2.call(`${W}.get`, { id: inst.id }, ctx))).status).toBe("waiting");
    expect((await fails(engine2.workflows.advance("acme", inst.id).pipe(Effect.provide(engine2.layer)))).code).toBe("WorkflowVersionMismatch");
  });
});
