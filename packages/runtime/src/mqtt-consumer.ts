/** Authenticated broker connections bind to deployment-owned tenant/subscription routes. */
import type { Engine } from "./engine.js";
import type { Model } from "./model.js";
import type { Envelope } from "./dispatch.js";
import { decodeObject } from "./decode.js";
import { mqttTopic, type MqttRoute } from "./mqtt.js";

export interface MqttConsumerRoute { tenant: string; subscription: string }
export function mqttBindings(model: Model): { routes: Record<string, MqttRoute>; subscriptions: Record<string, string[]> } {
  const routes: Record<string, MqttRoute> = {}, subscriptions: Record<string, string[]> = {};
  for (const channel of model.channels) {
    if (!channel.mqtt || channel.direction === "recv-only") continue;
    const subscription = `mqtt:${channel.id}`;
    routes[subscription] = { channel: channel.id, prefix: channel.mqtt.prefix };
    subscriptions[channel.id] = [subscription];
  }
  return { routes, subscriptions };
}

/** A route is authorization granted by the operator, not an identity claimed by a packet. */
export function mqttConsumer(engine: Engine, routes: MqttConsumerRoute[]) {
  const configured = new Map(routes.map(route => {
    const sub = engine.model.subscription(route.subscription);
    const channel = engine.model.channels.find(c => c.id === sub?.channel);
    const message = channel?.messages.find(m => m.name === sub?.message);
    if (!sub || !channel?.mqtt || !message || !engine.model.function(sub.handler)) throw new Error("MQTT consumer requires a declared bound channel subscription");
    if (channel.direction === "send-only") throw new Error("MQTT cannot consume a send-only channel");
    const topic = mqttTopic(channel.mqtt.prefix, route.tenant, channel.id, sub.name);
    return [topic, { tenant: route.tenant, sub: { ...sub }, fields: message.fields }] as const;
  }));
  if (configured.size !== routes.length || !configured.size) throw new Error("MQTT consumer requires unique concrete routes");
  return {
    topics: [...configured.keys()],
    async receive(topic: string, bytes: string | Uint8Array, packet: { qos: number; retain: boolean } = { qos: 1, retain: false }): Promise<"processed" | "duplicate"> {
      const route = configured.get(topic);
      if (!route) throw new Error("MQTT topic is not authorized");
      if (packet.qos !== 1) throw new Error("MQTT inbound commands require QoS1");
      if (packet.retain) throw new Error("MQTT retained commands are not supported");
      const size = typeof bytes === "string" ? new TextEncoder().encode(bytes).length : bytes.byteLength;
      if (size > 65536) throw new Error("MQTT payload too large");
      let env: Envelope;
      try {
        const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        env = JSON.parse(text) as Envelope;
        if (!env || typeof env !== "object" || Array.isArray(env) || env.tenant !== route.tenant || env.channel !== route.sub.channel || env.message !== route.sub.message || typeof env.opId !== "string" || !env.opId.length || env.opId.length > 256 || !Number.isSafeInteger(env.ordinal) || env.ordinal < 0 || env.messageId !== `${env.opId}:${env.ordinal}` || typeof env.createdAt !== "string" || !Number.isFinite(Date.parse(env.createdAt))) throw new Error();
        const decoded = decodeObject(engine.model, env.payload, { mode: "input", fields: route.fields });
        if (decoded.errors) throw new Error();
        // Pass only trusted envelope fields and canonical typed values to the engine.
        env = { tenant: route.tenant, channel: route.sub.channel, message: route.sub.message, opId: env.opId, ordinal: env.ordinal, messageId: env.messageId, createdAt: env.createdAt, payload: decoded.value };
      } catch { throw new Error("invalid MQTT command envelope"); }
      try {
        const result = await engine.consume(route.sub.name, env);
        if (result === "unknown-subscription") throw new Error();
        return result;
      } catch { throw new Error("MQTT command completion failed; message is not acknowledged"); }
    },
  };
}
