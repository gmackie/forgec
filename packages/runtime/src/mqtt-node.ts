/** Optional Node broker connection; the portable transport only needs a PUBACK-aware publisher. */
import { connectAsync, type IClientOptions } from "mqtt";
import { mqttTransport, type MqttRoute } from "./mqtt.js";
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
