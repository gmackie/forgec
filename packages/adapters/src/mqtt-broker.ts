/** Reproducible self-hosted Mosquitto desired deployment, with operator-supplied auth/ACL files. */
export interface MqttBrokerOptions { name: string; tls?: boolean; publish?: boolean }
export interface MqttBrokerPack { files: Record<string, string>; endpoints: { tcp: string; websocket: string } }
export function emitMqttBroker(options: MqttBrokerOptions): MqttBrokerPack {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.name)) throw new Error("invalid MQTT broker name");
  if (options.publish && !options.tls) throw new Error("published MQTT listeners require TLS");
  const tcp = options.tls ? 8883 : 1883, websocket = options.tls ? 9002 : 9001;
  const secrets = ["MQTT_PASSWORD_FILE", "MQTT_ACL_FILE", ...(options.tls ? ["MQTT_TLS_CERT", "MQTT_TLS_KEY"] : [])];
  const security = options.tls ? "certfile /run/secrets/MQTT_TLS_CERT\nkeyfile /run/secrets/MQTT_TLS_KEY\n" : "";
  const config = `# Forge-managed Mosquitto configuration; authentication/ACLs stay outside the pack.
persistence true
persistence_location /mosquitto/data/
log_dest stdout
allow_anonymous false
password_file /run/secrets/MQTT_PASSWORD_FILE
acl_file /run/secrets/MQTT_ACL_FILE
max_packet_size 131072
listener ${tcp}
protocol mqtt
${security}listener ${websocket}
protocol websockets
${security}`;
  const compose = {
    name: `forge-mqtt-${options.name}`,
    services: { mqtt: { image: "docker.io/library/eclipse-mosquitto:2.0.22", user: "1883:1883", read_only: true, tmpfs: ["/tmp"], restart: "unless-stopped", security_opt: ["no-new-privileges:true"], cap_drop: ["ALL"], volumes: ["./mosquitto.conf:/mosquitto/config/mosquitto.conf:ro", "mqtt-data:/mosquitto/data"], secrets, ...(options.publish ? { ports: [`${tcp}:${tcp}`, `${websocket}:${websocket}`] } : {}) } },
    secrets: Object.fromEntries(secrets.map(name => [name, { external: true }])), volumes: { "mqtt-data": {} },
  };
  return { files: { "compose.yaml": JSON.stringify(compose, null, 2) + "\n", "mosquitto.conf": config }, endpoints: { tcp: `${options.tls ? "mqtts" : "mqtt"}://mqtt:${tcp}`, websocket: `${options.tls ? "wss" : "ws"}://mqtt:${websocket}` } };
}
