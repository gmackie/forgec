/** Real MQTT 3.1.1 broker roundtrip; CI explicitly requires the local Mosquitto tools. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { connectAsync } from "mqtt";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { mqttTransport, mqttTopic } from "../src/mqtt.js";
import { emitMqttBroker } from "../../adapters/src/mqtt-broker.js";
import { connectMqttTransport, connectMqttConsumer } from "../src/mqtt-node.js";
import { setup } from "./mqtt-fixture.js";
import { mqttConsumer } from "../src/mqtt-consumer.js";
function available(): boolean { const result = spawnSync("mosquitto", ["-h"], { stdio: "ignore" }); return !result.error && !result.signal; }
const hasBroker = available();
if (process.env["FORGE_MQTT_TEST"] === "1" && !hasBroker) throw new Error("FORGE_MQTT_TEST requires mosquitto and mosquitto_passwd");
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
it.skipIf(!hasBroker)("publishes a Forge envelope through an authenticated broker with QoS1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-mqtt-"));
  const port = await freePort(), wsPort = await freePort();
  const passwordFile = join(dir, "passwd"), config = join(dir, "mosquitto.conf");
  // Isolated test credentials; never used for a deployed broker.
  execFileSync("mosquitto_passwd", ["-b", "-c", passwordFile, "fixture", "fixture-password"]);
  const aclFile = join(dir, "acl"), data = join(dir, "data");
  writeFileSync(aclFile, "user fixture\ntopic readwrite forge/#\n"); mkdirSync(data);
  const desired = emitMqttBroker({ name: "fixture" }).files["mosquitto.conf"]!;
  writeFileSync(config, `user ${userInfo().username}\n` + desired
    .replace("listener 1883", `listener ${port} 127.0.0.1`)
    .replace("listener 9001", `listener ${wsPort} 127.0.0.1`)
    .replace("/run/secrets/MQTT_PASSWORD_FILE", passwordFile)
    .replace("/run/secrets/MQTT_ACL_FILE", aclFile)
    .replace("/mosquitto/data/", data + "/"));
  const broker = spawn("mosquitto", ["-c", config], { stdio: ["ignore", "pipe", "pipe"] });
  let sub: Awaited<ReturnType<typeof connectAsync>> | undefined;
  let producer: Awaited<ReturnType<typeof connectMqttTransport>> | undefined;
  let commands: Awaited<ReturnType<typeof connectMqttConsumer>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("test broker startup timeout")), 5000);
      const ready = (bytes: Buffer) => { if (String(bytes).includes("running")) { clearTimeout(timeout); resolve(); } };
      broker.stdout.on("data", ready); broker.stderr.on("data", ready);
      broker.once("error", error => { clearTimeout(timeout); reject(error); });
      broker.once("exit", code => { if (code !== null) { clearTimeout(timeout); reject(new Error("test broker exited")); } });
    });
    const url = `mqtt://127.0.0.1:${port}`;
    const options = { username: "fixture", password: "fixture-password", reconnectPeriod: 0, connectTimeout: 1000 };
    sub = await connectAsync(url, options);
    const topic = mqttTopic("forge", "tenant", "channel", "mqtt-events");
    await sub.subscribeAsync(topic, { qos: 1 });
    const received = new Promise<{ body: unknown; qos: number; retain: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("broker message timeout")), 5000);
      sub!.once("message", (_topic, bytes, packet) => { clearTimeout(timer); resolve({ body: JSON.parse(bytes.toString()), qos: packet.qos, retain: packet.retain }); });
    });
    producer = await connectMqttTransport(`ws://127.0.0.1:${wsPort}`, { "mqtt-events": { channel: "channel", prefix: "forge" } }, options);
    const envelope = { channel: "channel", message: "Created", tenant: "tenant", opId: "op1", ordinal: 0, messageId: "op1:0", payload: { value: 1 }, createdAt: "2026-10-13T00:00:00Z" };
    await Effect.runPromise(producer.transport.send({ subscription: "mqtt-events", envelope }));
    expect(await received).toEqual({ body: envelope, qos: 1, retain: false });
    // Test direct mqtt.js structural compatibility too; no shim may acknowledge early.
    await Effect.runPromise(mqttTransport(sub, { "mqtt-events": { channel: "channel", prefix: "forge" } }).send({ subscription: "mqtt-events", envelope }));
    // A failed handler must leave an unacknowledged broker packet for the same durable session.
    const f = setup(), clientId = "forge-command-fixture";
    f.fail(true);
    commands = await connectMqttConsumer(url, f.engine, [f.route], { ...options, clientId });
    await sub.publishAsync(f.topic, JSON.stringify(f.envelope), { qos: 1, retain: false });
    expect(await commands.failure).toBeInstanceOf(Error);
    expect(f.calls()).toBe(1);
    f.fail(false);
    // Resume the TCP session through WebSockets with a recreated Engine and shared durable storage.
    commands = await connectMqttConsumer(`ws://127.0.0.1:${wsPort}`, f.create(), [f.route], { ...options, clientId });
    await expect.poll(() => f.calls(), { timeout: 5000 }).toBe(2);
    await expect.poll(async () => {
      try { return await mqttConsumer(f.create(), [f.route]).receive(f.topic, JSON.stringify(f.envelope)); }
      catch { return "pending"; }
    }, { timeout: 5000 }).toBe("duplicate");
    // Sending the same completed command again invokes no handler, including after restart.
    await commands.close();
    commands = await connectMqttConsumer(url, f.create(), [f.route], { ...options, clientId });
    await sub.publishAsync(f.topic, JSON.stringify(f.envelope), { qos: 1, retain: false });
    // A following packet is a processing barrier on this serialized MQTT session.
    await sub.publishAsync(f.topic, JSON.stringify({ ...f.envelope, opId: "barrier", messageId: "barrier:0" }), { qos: 1, retain: false });
    await expect.poll(() => f.calls(), { timeout: 5000 }).toBe(3);
  } finally {
    await commands?.close();
    await producer?.close(); await sub?.endAsync(true);
    const exited = new Promise(resolve => broker.once("exit", resolve));
    if (broker.exitCode === null) { broker.kill("SIGTERM"); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
