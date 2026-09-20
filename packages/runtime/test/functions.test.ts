/**
 * Implemented functions (plan §5.4, §8): the app supplies the body; the
 * runtime supplies exactly the declared dependencies as typed Effect services
 * — resource capabilities, transitions, external callables, and a publisher
 * limited to the declared `sends`. Publications stage in the outbox inside
 * the function's own commit.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine, type CallContext } from "../src/engine.js";
import { ForgeError, err } from "../src/errors.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction, type FunctionContext } from "../src/functions.js";

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

/** The reference implementation of SubmitOrder (examples/acme/impl/submit-order.ts, inlined). */
const submitOrder = defineFunction("@acme/commerce/_/SubmitOrder", (deps: FunctionContext) =>
  Effect.gen(function* () {
    const input = deps.input as { order: string; expectedVersion: number };
    const order = yield* deps.resources.Order!.get(input.order);
    const site = yield* deps.resources.Site!.get(order["site"] as string);
    if (!site["enabled"]) return yield* deps.fail("SiteDisabled", `site ${site["code"]} is disabled`);
    const auth = yield* deps.external("@acme/payments/_/AuthorizePayment", { amount: order["total"], reference: order["id"] });
    if (!auth.ok) return yield* deps.fail(auth.code === "PaymentDeclined" ? "PaymentDeclined" : "PaymentUnavailable", auth.detail);
    const submitted = yield* deps.transitions.Order!.submit!(input.order, input.expectedVersion, {});
    yield* deps.send("OrderEvents", "OrderSubmitted", { order: submitted["id"], customer: submitted["customer"], revision: submitted["version"] });
    return submitted;
  }),
);

let storage: MemoryStorage;
let engine: Engine;
let payments: (input: any) => { ok: true; value: any } | { ok: false; code: string; detail?: string };
let ids: { order: string; site: string };
beforeEach(async () => {
  storage = new MemoryStorage();
  payments = () => ({ ok: true, value: { authorizationId: "auth_1" } });
  engine = new Engine(model, testLayer(storage), { functions: [submitOrder], externals: { "@acme/payments/_/AuthorizePayment": (input) => Promise.resolve(payments(input)) } });
  const c = await run(engine.call("@acme/commerce/_/Customer.create", { code: "ACME", name: "A" }, ctx));
  const s = await run(engine.call("@acme/commerce/_/Site.create", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" }, ctx));
  const o = await run(engine.call("@acme/commerce/_/Order.create", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" }, ctx));
  ids = { order: o.id, site: s.id };
});

describe("implemented functions", () => {
  it("runs the body with declared dependencies, commits the transition, and stages the declared message in the outbox", async () => {
    const out = await run(engine.call("@acme/commerce/_/SubmitOrder", { order: ids.order, expectedVersion: 1 }, ctx));
    expect(out).toMatchObject({ id: ids.order, status: "Submitted", version: 2 });
    const d = await storage.dump("acme");
    const staged = d["outbox"]!.filter((o) => o.channel === "@acme/commerce/_/OrderEvents");
    expect(staged.map((o) => [o.message, o.payload])).toEqual([["OrderSubmitted", { order: ids.order, customer: expect.any(String), revision: 2 }]]);
    // same commit as the transition: same opId as the audit row of the transition
    expect(d["audit"]!.some((a) => a.kind === "status.submit" && a.opId === staged[0]!.opId)).toBe(true);
  });

  it("declared domain errors surface as typed function errors and nothing commits", async () => {
    await run(engine.call("@acme/commerce/_/Site.update", { id: ids.site, expectedVersion: 1, patch: { enabled: false } }, ctx));
    const e = await fails(engine.call("@acme/commerce/_/SubmitOrder", { order: ids.order, expectedVersion: 1 }, ctx));
    expect(e.code).toBe("@acme/commerce/_/SubmitOrder.SiteDisabled");
    expect(e.status).toBe(409);
    expect((await run(engine.call("@acme/commerce/_/Order.get", { id: ids.order }, ctx))).status).toBe("Draft");
    expect((await storage.dump("acme"))["outbox"]!.filter((o) => o.channel.endsWith("OrderEvents"))).toHaveLength(0);
  });

  it("external dependency failures map to declared errors; an undeclared error name is a compile-time contract violation", async () => {
    payments = () => ({ ok: false, code: "PaymentDeclined", detail: "insufficient funds" });
    const e = await fails(engine.call("@acme/commerce/_/SubmitOrder", { order: ids.order, expectedVersion: 1 }, ctx));
    expect(e.code).toBe("@acme/commerce/_/SubmitOrder.PaymentDeclined");
    expect(e.detail).toBe("insufficient funds");
  });

  it("sending to a channel or message not in `sends` is refused, and stale versions surface as VersionConflict", async () => {
    const rogue = defineFunction("@acme/commerce/_/SubmitOrder", (deps) => deps.send("OrderEvents", "Nope", {}));
    const e2 = new Engine(model, testLayer(new MemoryStorage()), { functions: [rogue], externals: {} });
    const e = await fails(e2.call("@acme/commerce/_/SubmitOrder", { order: ids.order, expectedVersion: 1 }, ctx));
    expect(e.code).toBe("Forbidden");
    expect(e.detail).toContain("Nope");
    const stale = await fails(engine.call("@acme/commerce/_/SubmitOrder", { order: ids.order, expectedVersion: 7 }, ctx));
    expect(stale.code).toBe("VersionConflict");
  });

  it("a function without an implementation fails a call with a clear error (production builds refuse to deploy)", async () => {
    const e = await fails(engine.call("@acme/commerce/_/RebuildOrderSummary", {}, ctx));
    expect(e.code).toBe("Internal");
    expect(e.detail).toContain("no implementation");
  });

  it("subscription handlers are invoked from envelopes with the message as input and dedup by messageId", async () => {
    const seen: string[] = [];
    const fulfill = defineFunction("@acme/commerce/_/FulfillOrder", (deps) =>
      Effect.gen(function* () {
        seen.push((deps.input as any).order);
        return yield* deps.resources.Order!.get((deps.input as any).order);
      }),
    );
    const e2 = new Engine(model, testLayer(storage), { functions: [submitOrder, fulfill], externals: { "@acme/payments/_/AuthorizePayment": async () => ({ ok: true, value: {} }) } });
    await run(e2.call("@acme/commerce/_/SubmitOrder", { order: ids.order, expectedVersion: 1 }, ctx));
    const env = { channel: "@acme/commerce/_/OrderEvents", message: "OrderSubmitted", tenant: "acme", opId: "op_x", ordinal: 0, messageId: "op_x:0", payload: { order: ids.order, customer: "c", revision: 2 }, createdAt: "t" };
    expect(await e2.consume("fulfill-order", env)).toBe("processed");
    expect(await e2.consume("fulfill-order", env)).toBe("duplicate");
    expect(seen).toEqual([ids.order]);
  });
});
