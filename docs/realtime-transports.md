# WebSockets and MQTT

For one-way HTTP log/event streams, see [streaming and binary HTTP](streaming-http.md).

Forge channels publish through a transactional outbox. A channel may have queue
consumers, WebSocket subscribers and MQTT deliveries together. These transports
have different acknowledgements; a broker PUBACK does not prove that a device
processed an event.

## WebSockets

The existing `@websocket("/v1/live/orders")` channel decorator binds a realtime
stream. Node hosts use `ws`, Cloudflare uses a Durable Object with hibernation,
and AWS uses API Gateway connections. Authenticated sessions subscribe or resume
by stream position. Tenant isolation, a bounded replay window and explicit gap
signals are part of the profile; stable socket identity and exactly-once delivery
are not. See [the language example](language.md#functions-channels-subscriptions).

If hub delivery fails after durable sequencing, the dispatcher retries the
original frame and sequence. Clients deduplicate by sequence/message ID. If that
frame leaves the replay window before retry, delivery fails explicitly rather
than acknowledging it; outbox retry/dead-letter policy applies. Reconnect and
resume remain necessary: a successful hub send does not prove client receipt.

## Existing MQTT broker

The portable `@forgegraph/runtime/mqtt` adapter accepts a PUBACK-aware publisher.
The Node-only `@forgegraph/runtime/mqtt-node` helper connects through MQTT.js to
TCP MQTT or MQTT-over-WebSocket endpoints. It is kept out of the main runtime
export so Node connection code is not imported by Workers.

```ts
import { connectMqttTransport } from "@forgegraph/runtime/mqtt-node";
import { composeRuntime } from "@forgegraph/runtime/compose";

const channel = "@acme/commerce/_/OrderEvents";
const broker = await connectMqttTransport("mqtts://broker.example.com:8883", {
  "mqtt-orders": { channel, prefix: "forge" },
}, { username: brokerUsername, password: brokerPassword }); // resolve privately at runtime

const runtime = composeRuntime({
  bundle, store, cursorSecret,
  transport: broker.transport,
  subscriptions: { [channel]: ["mqtt-orders"] },
});
// Sweep through your host's lifecycle. Stop/drain sweeps before closing the client.
// broker.close() forcibly closes the connection; unacknowledged events remain retryable.
```

A topic is `<prefix>/<escaped tenant>/<escaped channel>/<escaped subscription>`.
Use `mqttTopic` to compute it. Each segment uses URI encoding, so tenant names
cannot insert `/`, `+` or `#`. This naming scheme is not authorization: the broker
must enforce tenant-specific publish/subscribe ACLs. Restrict the Forge producer
identity to its intended topic namespace. Do not trust tenant IDs from incoming
MQTT payloads as authentication.

Publications contain the Forge envelope, including stable `messageId`. QoS is
fixed at 1 and retain is false. Outbox delivery succeeds only after PUBACK.
Disconnected clients, negative acknowledgements, payloads over 64 KiB and
acknowledgement timeouts fail delivery. Errors do not include broker credentials.
Timeouts cannot retract a broker write: late publication plus retry can duplicate
an event. Consumers must deduplicate message IDs. The default acknowledgement
timeout is 5 seconds; configure the dispatcher lease longer than the total time
spent delivering its subscriptions. MQTT 3.1.1 cannot signal every broker ACL
rejection through PUBACK; broker ACLs and end-to-end consumer verification still
matter. QoS 0/2 and retained state are not offered by this event transport.

The Node helper supports mqtt/mqtts/ws/wss URLs and reconnects after disconnects.
Use TLS for external brokers. Cloudflare Workers can supply a compatible broker
WebSocket publisher through the portable adapter; this slice does not certify
MQTT.js on Workers or provision a Cloudflare MQTT service.

## Self-hosted broker

```ts
import { emitMqttBroker } from "@forgegraph/adapters/mqtt-broker";
const pack = emitMqttBroker({ name: "events", tls: true, publish: true });
// Write pack.files to an isolated deployment directory, then deploy with Compose.
```

This generates a persistent Mosquitto 2.0.22 Compose service with TCP and
MQTT-over-WebSocket listeners. Default listeners are private to its Compose
network and publish no host ports. `publish: true` requires TLS and exposes
8883/9002. External files are required: `MQTT_PASSWORD_FILE` (Mosquitto password
file), `MQTT_ACL_FILE`, and for TLS `MQTT_TLS_CERT`/`MQTT_TLS_KEY`. Provision these
as Compose secrets, readable by UID 1883, without committing their bytes. The
persistent data volume must also be writable by UID 1883. Anonymous access is
disabled and the container runs with a read-only root and dropped capabilities.

Use a Docker Compose backend that supports external secrets (or resolve these
references through your platform's secret integration); ordinary local Compose
may require a private override mapping them to files. Application services must
join the broker network; the pack does not silently change app dependencies or
inject credentials. Its endpoint metadata uses the internal service name `mqtt`.
It is a separate self-hosted broker pack, not an in-process Forge broker or a
Cloudflare-native service. Nix/managed broker provisioning is not emitted.

Both broker modes support publication and inbound commands through the same
connector. Production broker deployment and health certification remain separate work.

## Typed bindings and inbound commands

Declare `@mqtt("forge/events")` on a channel. Prefixes are concrete slash-separated
ASCII letters, digits, underscores and hyphens, at most 128 bytes; wildcards and
empty segments are rejected. The IR requires `mqtt/1`, and the messaging plan
records QoS1, nonretained envelopes, a 64 KiB limit and
`execution: "external-broker-connector"`. This describes an operator-wired
connector, not a managed MQTT service on Cloudflare or AWS. MQTT.js is Node-only;
other hosts need a compatible lifecycle and completion-aware broker client.

For outbound bindings, use `mqttBindings(model)` from
`@forgegraph/runtime/mqtt-consumer` and pass its routes to `connectMqttTransport`
and its subscriptions to your dispatcher. Merge these subscriptions with other
channel destinations. Receive-only channels have no outbound route.
`composeRuntime` rejects outbound MQTT bindings without an explicit transport
and channel subscription mapping, rather than silently using in-process delivery.

For commands, declare a channel message and its subscription handler, then bind
that subscription to a trusted tenant in deployment configuration:

```ts
import { connectMqttConsumer } from "@forgegraph/runtime/mqtt-node";
const commands = await connectMqttConsumer(brokerUrl, engine, [
  { tenant: trustedTenant, subscription: declaredSubscriptionName },
], { clientId: stableDeploymentClientId, username: brokerUsername, password: brokerPassword });
const failure = await commands.failure; // undefined when deliberately closed
if (failure) reportFailure(failure); // restart the same durable session after remediation
```

The connection authenticates to either broker mode with operator-provisioned
credentials. Broker ACLs must restrict each command producer to its tenant's
exact topics; the connector does not receive a publisher identity from MQTT.
Tenant and subscription routes come from trusted configuration, never payloads.
Use separate credentials/sessions for separate trust boundaries. Send-only
channels cannot receive commands.

Inbound topics must exactly match `mqttTopic(prefix, tenant, channel, subscription)`.
Envelopes must match that tenant, channel and message, provide a stable
`messageId = opId + ":" + ordinal`, and pass the declared message field codecs and
constraints before the handler runs. QoS0/2, retained commands, invalid UTF-8,
oversized packets and malformed envelopes are rejected.
MQTT 3.1.1 marks retained replay packets, but clears the retain flag for live
delivery to existing subscriptions. Producers must use `retain: false`; broker
policy must enforce that if retained publication is forbidden for the application.

The Node connector installs its completion callback before opening the socket.
It sends PUBACK only after `Engine.consume` commits handler writes and delivery
completion, or confirms a completed duplicate. It enforces MQTT 3.1.1, `clean:
false`, and a stable client ID. Failure or disconnect stops the connector;
observe `failure` and explicitly restart with the same client ID after fixing
the cause. The broker must retain durable sessions and unacknowledged QoS1
packets. Invalid commands can block a session until an operator removes or
remediates them; there is no automatic poison-message acknowledgement.

Deduplication survives engine restart when storage persists. Reusing an identity
with changed canonical content fails, and an ambiguous external side effect requires
reconciliation rather than acknowledgement. Memory storage demonstrates the
contract in tests; production requires the runtime's durable atomic storage.
