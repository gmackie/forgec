import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { mqttTransport, mqttTopic, type MqttPublisher } from "../src/mqtt.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { Dispatcher } from "../src/dispatch.js";
import type { Delivery } from "../src/dispatch.js";
const delivery: Delivery = { subscription: "mqtt-orders", envelope: { channel: "@acme/OrderEvents", message: "Created", tenant: "tenant/+#", opId: "op1", ordinal: 0, messageId: "op1:0", payload: { id: "1" }, createdAt: "2026-10-13T00:00:00Z" } };
const routes = { "mqtt-orders": { channel: "@acme/OrderEvents", prefix: "forge" } };
describe("MQTT channel transport", () => {
  it("retries broker failure through the outbox with the same message ID", async () => {
    const model = new Model(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle);
    const store = new MemoryStorage(); const engine = new Engine(model, testLayer(store));
    const channel = "@acme/commerce/_/Customer.changes";
    await Effect.runPromise(engine.call("@acme/commerce/_/Customer.create", { code: "MQTT", name: "C" }, { tenant: "acme", actor: "test", requestId: "test" }));
    const ids: string[] = [];
    const client: MqttPublisher = { connected: true, publish: (_topic, payload, _options, cb) => { ids.push(JSON.parse(payload).messageId); cb(ids.length === 1 ? new Error("broker failure") : undefined); } };
    const dispatcher = new Dispatcher(model, store, mqttTransport(client, { events: { channel, prefix: "forge" } }), { subscriptions: { [channel]: ["events"] }, leaseMs: 1000, maxAttempts: 3 });
    expect(await Effect.runPromise(dispatcher.sweep("acme", { now: 1000 }))).toMatchObject({ delivered: 0, failed: 1 });
    expect(await Effect.runPromise(dispatcher.sweep("acme", { now: 3000 }))).toMatchObject({ delivered: 1, failed: 0 });
    expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]);
    expect(await Effect.runPromise(dispatcher.sweep("acme", { now: 5000 }))).toMatchObject({ claimed: 0 });
  });
  it("waits for QoS1 acknowledgement and preserves the envelope", async () => {
    let ack!: (error?: Error | null) => void;
    const publish = vi.fn<MqttPublisher["publish"]>((_topic, _payload, _options, callback) => { ack = callback; });
    let done = false;
    const result = Effect.runPromise(mqttTransport({ connected: true, publish }, routes).send(delivery)).then(() => { done = true; });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    const [topic, payload, options] = publish.mock.calls[0]!;
    expect(topic).toBe("forge/tenant%2F%2B%23/%40acme%2FOrderEvents/mqtt-orders");
    expect(JSON.parse(payload)).toEqual(delivery.envelope);
    expect(options).toEqual({ qos: 1, retain: false });
    ack(); await result; expect(done).toBe(true);
  });
  it("redacts broker errors and refuses disconnected publication", async () => {
    const client: MqttPublisher = { connected: true, publish: (_t, _p, _o, cb) => cb(new Error("mqtt://user:secret@broker")) };
    await expect(Effect.runPromise(mqttTransport(client, routes).send(delivery))).rejects.toThrow("MQTT publication failed");
    client.connected = false;
    await expect(Effect.runPromise(mqttTransport(client, routes).send(delivery))).rejects.toThrow(/disconnected/);
  });
  it("bounds acknowledgement time and handles synchronous broker failures", async () => {
    await expect(Effect.runPromise(mqttTransport({ connected: true, publish: () => {} }, routes, { ackTimeoutMs: 10 }).send(delivery))).rejects.toThrow(/acknowledgement timed out/);
    await expect(Effect.runPromise(mqttTransport({ connected: true, publish: () => { throw new Error("secret"); } }, routes).send(delivery))).rejects.toThrow("MQTT publication failed");
  });
  it("rejects wrong channels, unknown subscriptions and oversized payloads before publishing", async () => {
    const publish = vi.fn(); const transport = mqttTransport({ connected: true, publish }, routes);
    await expect(Effect.runPromise(transport.send({ ...delivery, subscription: "unknown" }))).rejects.toThrow(/route/);
    await expect(Effect.runPromise(transport.send({ ...delivery, envelope: { ...delivery.envelope, channel: "other" } }))).rejects.toThrow(/channel/);
    await expect(Effect.runPromise(transport.send({ ...delivery, envelope: { ...delivery.envelope, payload: "x".repeat(65536) } }))).rejects.toThrow(/too large/);
    expect(publish).not.toHaveBeenCalled();
  });
  it("uses tenant-isolated concrete topics and rejects wildcard prefixes", () => {
    expect(mqttTopic("forge", "a/b", "c", "s")).not.toBe(mqttTopic("forge", "a%2Fb", "c", "s"));
    expect(() => mqttTransport({ connected: true, publish: () => {} }, { bad: { channel: "c", prefix: "forge/#" } })).toThrow(/prefix/);
  });
});
