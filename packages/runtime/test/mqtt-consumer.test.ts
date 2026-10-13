import { describe, expect, it } from "vitest";
import { mqttConsumer, mqttBindings } from "../src/mqtt-consumer.js";
import { setup, channel } from "./mqtt-fixture.js";
import { composeRuntime } from "../src/hosts/compose.js";
import { MemoryStorage } from "../src/adapters/memory.js";
describe("MQTT authenticated consumption", () => {
  it("fails composition explicitly when outbound MQTT bindings have no connector", () => {
    const f = setup();
    expect(() => composeRuntime({ bundle: f.engine.model.bundle, store: new MemoryStorage(), cursorSecret: "fixture" })).toThrow(/MQTT.*connector/);
  });
  it("passes canonical decoded values to the command handler", async () => {
    const f = setup();
    f.engine.model.channels.find(c => c.id === channel)!.messages[0]!.fields[0]!.type.normalizers = ["trim", "lowercase"];
    await mqttConsumer(f.engine, [f.route]).receive(f.topic, JSON.stringify({ ...f.envelope, payload: { value: " OK " } }));
    expect(f.inputs).toEqual([{ value: "ok" }]);
  });
  it("binds topic and tenant from configuration, validates input and deduplicates after restart", async () => {
    const f = setup(), consume = mqttConsumer(f.engine, [f.route]);
    expect(await consume.receive(f.topic, JSON.stringify(f.envelope))).toBe("processed");
    expect(await mqttConsumer(f.create(), [f.route]).receive(f.topic, JSON.stringify(f.envelope))).toBe("duplicate");
    expect(f.calls()).toBe(1);
  });
  it("rejects cross-tenant, wrong channel/message, malformed input and retained or wrong-QoS packets before invocation", async () => {
    const f = setup(), consume = mqttConsumer(f.engine, [f.route]);
    for (const patch of [{ tenant: "other" }, { channel: "other" }, { message: "Other" }, { messageId: "other" }, { payload: { value: 1 } }]) {
      await expect(consume.receive(f.topic, JSON.stringify({ ...f.envelope, ...patch }))).rejects.toThrow(/MQTT/);
    }
    await expect(consume.receive("other/topic", JSON.stringify(f.envelope))).rejects.toThrow(/MQTT/);
    await expect(consume.receive(f.topic, "{bad")).rejects.toThrow(/MQTT/);
    await expect(consume.receive(f.topic, new Uint8Array([0xff]))).rejects.toThrow(/MQTT/);
    await expect(consume.receive(f.topic, "x".repeat(65537))).rejects.toThrow(/MQTT/);
    await expect(consume.receive(f.topic, JSON.stringify(f.envelope), { qos: 0, retain: false })).rejects.toThrow(/QoS/);
    await expect(consume.receive(f.topic, JSON.stringify(f.envelope), { qos: 1, retain: true })).rejects.toThrow(/retained/);
    await expect(consume.receive(f.topic, JSON.stringify({ ...f.envelope, payload: { value: "ok", injected: "field" } }))).rejects.toThrow(/MQTT/);
    expect(f.calls()).toBe(0);
  });
  it("leaves handler failures retryable and blocks identity reuse with altered content", async () => {
    const f = setup(), consume = mqttConsumer(f.engine, [f.route]);
    f.fail(true); await expect(consume.receive(f.topic, JSON.stringify(f.envelope))).rejects.toThrow(/MQTT/);
    f.fail(false); expect(await consume.receive(f.topic, JSON.stringify(f.envelope))).toBe("processed");
    await expect(consume.receive(f.topic, JSON.stringify({ ...f.envelope, payload: { value: "changed" } }))).rejects.toThrow(/MQTT/);
    expect(f.calls()).toBe(2);
  });
  it("derives outbound routes while excluding receive-only channels", () => {
    const f = setup();
    expect(mqttBindings(f.engine.model).routes[`mqtt:${channel}`]).toEqual({ channel, prefix: "forge/events" });
    f.engine.model.channels.find(c => c.id === channel)!.direction = "recv-only";
    expect(mqttBindings(f.engine.model).routes).toEqual({});
  });
});
