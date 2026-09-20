/**
 * Outbox dispatch (plan §14): committed outbox rows reach every logical
 * subscription independently, at-least-once, with per-subscription delivery
 * status, bounded retries, poison handling, and consumer dedup.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { Dispatcher, type Transport, type Delivery } from "../src/dispatch.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };

class FakeTransport implements Transport {
  readonly name = "fake";
  sent: Delivery[] = [];
  failFor = new Set<string>();
  send = (d: Delivery) => (this.failFor.has(d.subscription) ? Effect.fail(new Error(`transport down for ${d.subscription}`)) : Effect.sync(() => void this.sent.push(d)));
}

let storage: MemoryStorage;
let engine: Engine;
let transport: FakeTransport;
let dispatcher: Dispatcher;
beforeEach(() => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage));
  transport = new FakeTransport();
  dispatcher = new Dispatcher(model, storage, transport, { subscriptions: { "@acme/commerce/_/Customer.changes": ["audit-mirror", "search-index"] }, leaseMs: 5000, maxAttempts: 3 });
});
const run = <A>(e: Effect.Effect<A, any, never>) => Effect.runPromise(e);

describe("Dispatcher", () => {
  it("delivers each committed event once per logical subscription and marks them delivered", async () => {
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    const r = await run(dispatcher.sweep("acme", { now: 1000 }));
    expect(r).toEqual({ claimed: 1, delivered: 2, failed: 0, dead: 0 });
    expect(transport.sent.map((d) => [d.subscription, d.envelope.message, d.envelope.payload.id])).toEqual([["audit-mirror", "Created", "cus_0001"], ["search-index", "Created", "cus_0001"]]);
    expect(transport.sent[0]!.envelope).toMatchObject({ channel: "@acme/commerce/_/Customer.changes", tenant: "acme", opId: "op_000001", ordinal: 0, messageId: "op_000001:0" });
    const again = await run(dispatcher.sweep("acme", { now: 2000 }));
    expect(again).toEqual({ claimed: 0, delivered: 0, failed: 0, dead: 0 });
  });

  it("a failed subscription does not repeat an already-completed one; retries only the failed delivery", async () => {
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    transport.failFor.add("search-index");
    const first = await run(dispatcher.sweep("acme", { now: 1000 }));
    expect(first).toEqual({ claimed: 1, delivered: 1, failed: 1, dead: 0 });
    // lease still held: nothing to do
    expect(await run(dispatcher.sweep("acme", { now: 2000 }))).toEqual({ claimed: 0, delivered: 0, failed: 0, dead: 0 });
    transport.failFor.clear();
    const second = await run(dispatcher.sweep("acme", { now: 7000 }));
    expect(second).toEqual({ claimed: 1, delivered: 1, failed: 0, dead: 0 });
    expect(transport.sent.map((d) => d.subscription)).toEqual(["audit-mirror", "search-index"]);
  });

  it("after maxAttempts a row is parked as dead (poison) and no longer swept", async () => {
    await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
    transport.failFor.add("audit-mirror");
    transport.failFor.add("search-index");
    for (const now of [1000, 7000, 13000]) await run(dispatcher.sweep("acme", { now }));
    const last = await run(dispatcher.sweep("acme", { now: 19000 }));
    expect(last).toEqual({ claimed: 0, delivered: 0, failed: 0, dead: 0 });
    const dead = await run(dispatcher.dead("acme"));
    expect(dead.map((d) => [d.opId, d.attempts, d.status])).toEqual([["op_000001", 3, "dead"]]);
    transport.failFor.clear();
    const redriven = await run(dispatcher.redrive("acme", "op_000001", 0));
    expect(redriven).toBe(true);
    expect(await run(dispatcher.sweep("acme", { now: 20000 }))).toEqual({ claimed: 1, delivered: 2, failed: 0, dead: 0 });
  });

  it("consumer-side dedup: the same messageId is processed once per subscription even if delivered twice", async () => {
    const processed: string[] = [];
    const consumer = dispatcher.consumer("search-index", async (env) => {
      processed.push(env.messageId);
    });
    const env = { channel: "c", message: "M", tenant: "acme", opId: "op_1", ordinal: 0, messageId: "op_1:0", payload: {}, createdAt: "t" };
    expect(await consumer(env)).toBe("processed");
    expect(await consumer(env)).toBe("duplicate");
    expect(processed).toEqual(["op_1:0"]);
  });
});
