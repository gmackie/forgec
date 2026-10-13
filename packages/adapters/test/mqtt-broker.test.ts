import { describe, expect, it } from "vitest";
import { emitMqttBroker } from "../src/mqtt-broker.js";
describe("self-hosted MQTT broker pack", () => {
  it("emits persistent private Mosquitto with TCP and WebSocket listeners and external authentication", () => {
    const pack = emitMqttBroker({ name: "events" });
    const compose = JSON.parse(pack.files["compose.yaml"]!);
    expect(compose.services.mqtt.image).toMatch(/eclipse-mosquitto:2\.0\./);
    expect(compose.services.mqtt.ports).toBeUndefined();
    expect(compose.services.mqtt.volumes).toContain("mqtt-data:/mosquitto/data");
    expect(compose.secrets.MQTT_PASSWORD_FILE).toEqual({ external: true });
    expect(pack.files["mosquitto.conf"]).toContain("allow_anonymous false");
    expect(pack.files["mosquitto.conf"]).toContain("listener 1883\nprotocol mqtt");
    expect(pack.files["mosquitto.conf"]).toContain("listener 9001\nprotocol websockets");
    expect(pack.files["mosquitto.conf"]).toContain("acl_file /run/secrets/MQTT_ACL_FILE");
    expect(pack.files["mosquitto.conf"]).toContain("persistence true");
  });
  it("can publish TLS listeners only with external cert/key files", () => {
    expect(() => emitMqttBroker({ name: "events", publish: true })).toThrow(/TLS/);
    const pack = emitMqttBroker({ name: "events", publish: true, tls: true });
    const compose = JSON.parse(pack.files["compose.yaml"]!);
    expect(compose.services.mqtt.ports).toEqual(["8883:8883", "9002:9002"]);
    expect(pack.files["mosquitto.conf"]).toContain("keyfile /run/secrets/MQTT_TLS_KEY");
    expect(compose.secrets.MQTT_TLS_KEY).toEqual({ external: true });
  });
  it("rejects unsafe names", () => expect(() => emitMqttBroker({ name: "../events" })).toThrow(/name/));
});
