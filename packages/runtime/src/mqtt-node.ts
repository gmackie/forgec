/** Optional Node broker connection; the portable transport only needs a PUBACK-aware publisher. */
import { connect, connectAsync, type IClientOptions, type MqttClient } from "mqtt";
import { mqttTransport, type MqttRoute } from "./mqtt.js";
import { mqttConsumer, type MqttConsumerRoute } from "./mqtt-consumer.js";
import type { Engine } from "./engine.js";

/** The MQTT.js QoS1 callback emits PUBACK. On failure the owner must close the connection. */
export function commandAcknowledgement(consumer: Pick<ReturnType<typeof mqttConsumer>, "receive">, stop: (error: Error) => void): MqttClient["handleMessage"] {
  return (packet, acknowledge) => {
    void consumer.receive(packet.topic, packet.payload, packet).then(
      () => acknowledge(),
      () => stop(new Error("MQTT command completion failed; consumer stopped without acknowledgement")),
    );
  };
}

/** Dedicated durable MQTT 3.1.1 session. Restart explicitly after a failure to redeliver. */
export async function connectMqttConsumer(url: string, engine: Engine, routes: MqttConsumerRoute[], options: IClientOptions & { clientId: string }) {
  const consumer = mqttConsumer(engine, routes);
  if (!options.clientId?.trim()) throw new Error("MQTT commands require a stable clientId");
  try {
    if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(new URL(url).protocol)) throw new Error();
  } catch { throw new Error("invalid MQTT broker endpoint"); }
  // Enforce the session/acknowledgement contract even when caller options conflict.
  const client = connect(url, { ...options, protocolVersion: 4, clean: false, manualConnect: true, reconnectPeriod: 0, resubscribe: false, connectTimeout: 5000, queueQoSZero: false });
  let closed = false;
  let stopped!: (error: Error | undefined) => void;
  const failure = new Promise<Error | undefined>(resolve => { stopped = resolve; });
  let startupReject: (error: Error) => void = () => {};
  const stop = (error: Error) => {
    if (closed) return;
    closed = true; startupReject(error);
    // No PUBACK on this path. Broker retains the packet in the persistent session.
    void client.endAsync(true).then(() => stopped(error), () => stopped(error));
  };
  const handle = commandAcknowledgement(consumer, stop);
  // MQTT.js can send PUBREC before handleMessage for QoS2. Reject it at the earlier hook.
  client.options.customHandleAcks = (_topic, _payload, packet, callback) => {
    if (packet.qos !== 1) {
      const error = new Error("MQTT inbound commands require QoS1");
      stop(error); callback(error); return;
    }
    callback(0);
  };
  client.handleMessage = (packet, ack) => {
    if (!closed) handle(packet, () => { if (!closed) ack(); });
  };
  client.on("error", () => stop(new Error("MQTT consumer connection failed")));
  client.on("close", () => stop(new Error("MQTT consumer disconnected; restart the durable session")));
  await new Promise<void>((resolve, reject) => {
    startupReject = reject;
    const timeout = setTimeout(() => stop(new Error("MQTT consumer startup timed out")), 5000);
    void failure.then(() => clearTimeout(timeout));
    client.once("connect", () => {
      void client.subscribeAsync(consumer.topics, { qos: 1 }).then(granted => {
        if (closed) return;
        if (granted.length !== consumer.topics.length || granted.some(g => g.qos !== 1)) {
          stop(new Error("MQTT broker did not grant required command subscriptions")); return;
        }
        clearTimeout(timeout); resolve();
      }, () => stop(new Error("MQTT command subscription failed")));
    });
    client.connect();
  });
  return {
    failure,
    async close() {
      if (closed) return;
      closed = true; stopped(undefined);
      await client.endAsync(true);
    },
  };
}
export async function connectMqttTransport(url: string, routes: Record<string, MqttRoute>, options: IClientOptions = {}) {
  // Validate before opening a socket. No connection URL or credentials appear in our errors.
  mqttTransport({ connected: false, publish: () => {} }, routes);
  try {
    const endpoint = new URL(url);
    if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(endpoint.protocol)) throw new Error();
  } catch { throw new Error("invalid MQTT broker endpoint"); }
  try {
    const client = await connectAsync(url, { connectTimeout: 5000, reconnectPeriod: 1000, queueQoSZero: false, ...options }, false);
    // mqtt.js emits asynchronous errors even after connection; dispatch observes disconnects/failed PUBACKs.
    client.on("error", () => {});
    return { transport: mqttTransport(client, routes), close: () => client.endAsync(true) };
  } catch { throw new Error("MQTT broker connection failed"); }
}
