/**
 * Realtime profile (§19): text JSON frames, capped size, per-stream logical
 * sequence numbers, bounded replay on resume (with an explicit gap signal),
 * at-least-once through the same outbox as every other consumer. Connection
 * identity is never promised across disconnects; the stream position is.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { Dispatcher } from "../src/dispatch.js";
import { withProjections, internalSubscriptions } from "../src/readmodels.js";
import { SessionProtocol, type RealtimeFrame, type RealtimeHub } from "../src/realtime.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const ctx: CallContext = { tenant: "acme", actor: "operator", requestId: "req" };
const run = <A>(e: Effect.Effect<A, unknown, never>) => Effect.runPromise(e as Effect.Effect<A, never, never>);
const CH = "@acme/commerce/_/OrderEvents";

let storage: MemoryStorage;
let engine: Engine;
let broadcasts: { tenant: string; channel: string; frame: RealtimeFrame }[];
let hub: RealtimeHub;
let ids: { customer: string; site: string };
beforeEach(async () => {
  storage = new MemoryStorage();
  engine = new Engine(model, testLayer(storage), { functions, externals });
  broadcasts = [];
  hub = { broadcast: async (tenant, channel, frame) => void broadcasts.push({ tenant, channel, frame }) };
  engine.realtime.hub = hub;
  const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  ids = { customer: c.id, site: s.id };
});
const sweep = () => {
  const d = new Dispatcher(model, storage, withProjections(engine, { name: "none", send: () => Effect.void }), { subscriptions: internalSubscriptions(engine), leaseMs: 1000, maxAttempts: 3 });
  return Effect.runPromise(d.sweep("acme", { now: Date.now() }));
};
const submit = async () => {
  const o = await run(engine.call("@acme/commerce/_/Order.create", { customer: ids.customer, site: ids.site, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" }, ctx));
  await run(engine.call("@acme/commerce/_/SubmitOrder", { order: o.id, expectedVersion: 1 }, ctx));
  return o.id;
};

describe("stream ledger", () => {
  it("bound channels are streams; publications get increasing per-stream sequence numbers and reach the hub through the outbox", async () => {
    expect(engine.realtime.streams().map((s) => [s.channel, s.path])).toEqual([[CH, "/v1/live/orders"]]);
    const o1 = await submit();
    await sweep();
    const o2 = await submit();
    await sweep();
    expect(broadcasts.map((b) => [b.channel, b.frame.type, (b.frame as any).seq, (b.frame as any).message, (b.frame as any).payload.order])).toEqual([[CH, "event", 1, "OrderSubmitted", o1], [CH, "event", 2, "OrderSubmitted", o2]]);
    // a redelivery of the same envelope (at-least-once) does not mint a new sequence number
    await sweep();
    expect(broadcasts).toHaveLength(2);
  });

  it("replay is bounded by the profile's depth and reports a gap when the resume point fell out of the window", async () => {
    engine.realtime.replayDepth = 3;
    for (let i = 0; i < 5; i++) { await submit(); await sweep(); }
    const all = await run(engine.realtime.replay("acme", CH, 0).pipe(Effect.provide(engine.layer)));
    expect(all.gap).toBe(true);
    expect(all.frames.map((f) => f.seq)).toEqual([3, 4, 5]);
    const tail = await run(engine.realtime.replay("acme", CH, 3).pipe(Effect.provide(engine.layer)));
    expect(tail).toMatchObject({ gap: false, latest: 5 });
    expect(tail.frames.map((f) => f.seq)).toEqual([4, 5]);
  });
});

describe("session protocol", () => {
  it("subscribe acknowledges with the latest sequence; resume replays after a position; unknown streams and oversized frames are errors; ping/pong", async () => {
    await submit();
    await sweep();
    const s = new SessionProtocol(engine, "acme");
    const hello = await s.handle(JSON.stringify({ type: "subscribe", stream: CH }));
    expect(hello).toEqual([{ type: "hello", stream: CH, latest: 1 }]);
    expect(s.subscribed(CH)).toBe(true);
    const resumed = await s.handle(JSON.stringify({ type: "resume", stream: CH, after: 0 }));
    expect(resumed[0]).toMatchObject({ type: "resumed", stream: CH, after: 0, replayed: 1, gap: false, latest: 1 });
    expect(resumed[1]).toMatchObject({ type: "event", seq: 1, message: "OrderSubmitted" });
    expect(await s.handle(JSON.stringify({ type: "subscribe", stream: "@acme/commerce/_/Nope" }))).toEqual([{ type: "error", code: "UnknownStream", detail: "@acme/commerce/_/Nope" }]);
    expect(await s.handle("x".repeat(70_000))).toEqual([{ type: "error", code: "FrameTooLarge", detail: "65536" }]);
    expect(await s.handle("not json")).toEqual([{ type: "error", code: "MalformedFrame", detail: "text JSON expected" }]);
    expect(await s.handle(JSON.stringify({ type: "ping" }))).toEqual([{ type: "pong" }]);
  });

  it("a session only receives streams it subscribed to, in its own tenant", async () => {
    const s = new SessionProtocol(engine, "acme");
    expect(s.accepts("acme", CH)).toBe(false);
    await s.handle(JSON.stringify({ type: "subscribe", stream: CH }));
    expect(s.accepts("acme", CH)).toBe(true);
    expect(s.accepts("other", CH)).toBe(false);
  });
});
