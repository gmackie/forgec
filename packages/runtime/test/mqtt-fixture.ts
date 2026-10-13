import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { defineFunction } from "../src/functions.js";
import { mqttTopic } from "../src/mqtt.js";
const bundle = JSON.parse(readFileSync(new URL("../../../conformance/fixtures/acme.app.json", import.meta.url), "utf8")) as AppBundle;
export const channel = "@acme/commerce/_/OrderEvents";
const handler = "@acme/commerce/_/FulfillOrder";
const subscription = bundle.messaging!.subscriptions.find(s => s.handler === handler)!.name;
export function setup() {
  const b = structuredClone(bundle);
  const c = b.ir.modules.flatMap(m => m.channels).find(c => c.id === channel)!;
  c.mqtt = { prefix: "forge/events" };
  c.messages[0]!.fields = [{ name: "value", immutable: false, serverOwned: false, synthesized: false, type: { base: { kind: "scalar", name: "text", args: [] }, optional: false, normalizers: [], constraints: [] } }];
  const model = new Model(b), storage = new MemoryStorage();
  let calls = 0, fail = false;
  const inputs: unknown[] = [];
  const create = () => new Engine(model, testLayer(storage), { functions: [defineFunction(handler, ctx => { calls++; inputs.push(ctx.input); return fail ? Effect.fail(new Error("handler failed")) as never : Effect.succeed({}); })] });
  const engine = create();
  const route = { tenant: "acme", subscription };
  const topic = mqttTopic("forge/events", "acme", channel, subscription);
  const envelope = { channel, message: "OrderSubmitted", tenant: "acme", opId: "inbound", ordinal: 0, messageId: "inbound:0", payload: { value: "ok" }, createdAt: "2026-10-13T00:00:00Z" };
  return { engine, create, route, topic, envelope, inputs, calls: () => calls, fail: (value: boolean) => { fail = value; } };
}
