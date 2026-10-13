/** MQTT QoS1 publishing through the same durable outbox as queue deliveries. */
import { Effect } from "effect";
import type { Transport } from "./dispatch.js";
export interface MqttPublisher {
  connected: boolean;
  /** Callback must run after PUBACK, not merely after buffering or writing bytes. */
  publish(topic: string, payload: string, options: { qos: 1; retain: false }, callback: (error?: Error | null) => void): unknown;
}
export interface MqttRoute { channel: string; prefix: string }
function validPrefix(prefix: string): boolean {
  return typeof prefix === "string" && /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix) && prefix.length <= 128;
}
/** Concrete, injective UTF-8 topic segments. Never interpolate unescaped tenant/channel names. */
export function mqttTopic(prefix: string, tenant: string, channel: string, subscription: string): string {
  if (!validPrefix(prefix)) throw new Error("invalid MQTT topic prefix");
  const segments = [tenant, channel, subscription];
  if (segments.some(s => typeof s !== "string" || !s.length)) throw new Error("invalid MQTT topic segment");
  try {
    const topic = [prefix, ...segments.map(s => encodeURIComponent(s))].join("/");
    if (new TextEncoder().encode(topic).length > 4096) throw new Error();
    return topic;
  } catch { throw new Error("invalid MQTT topic segment"); }
}
export function mqttTransport(client: MqttPublisher, routes: Record<string, MqttRoute>, options: { ackTimeoutMs?: number; maxPayloadBytes?: number } = {}): Transport {
  const ackTimeoutMs = options.ackTimeoutMs ?? 5000;
  const maxPayloadBytes = options.maxPayloadBytes ?? 65536;
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 60000) throw new Error("invalid MQTT acknowledgement timeout");
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > 65536) throw new Error("invalid MQTT payload bound");
  const configured = new Map(Object.entries(routes).map(([name, route]) => {
    if (!validPrefix(route.prefix)) throw new Error("invalid MQTT topic prefix");
    mqttTopic(route.prefix, "tenant", route.channel, name);
    return [name, { ...route }];
  }));
  return { name: "mqtt", send: delivery => Effect.tryPromise({
    try: signal => new Promise<void>((resolve, reject) => {
      const route = configured.get(delivery.subscription);
      if (!route) return reject(new Error("no MQTT route for subscription"));
      if (route.channel !== delivery.envelope.channel) return reject(new Error("MQTT route channel mismatch"));
      if (!client.connected) return reject(new Error("MQTT broker disconnected"));
      let topic: string, payload: string;
      try {
        topic = mqttTopic(route.prefix, delivery.envelope.tenant, route.channel, delivery.subscription);
        payload = JSON.stringify(delivery.envelope);
      } catch { return reject(new Error("invalid MQTT envelope")); }
      if (new TextEncoder().encode(payload).length > maxPayloadBytes) return reject(new Error("MQTT payload too large"));
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error("MQTT publication interrupted"));
      const timer = setTimeout(() => finish(new Error("MQTT acknowledgement timed out")), ackTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      try { client.publish(topic, payload, { qos: 1, retain: false }, error => finish(error ? new Error("MQTT publication failed") : undefined)); }
      catch { finish(new Error("MQTT publication failed")); }
    }),
    catch: error => error instanceof Error ? error : new Error("MQTT publication failed"),
  }) };
}
