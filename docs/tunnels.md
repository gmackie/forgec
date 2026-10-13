# Cloudflare Tunnel primitive

`@forgegraph/adapters/tunnels` provides an experimental Cloudflare-first
primitive in the resolved deployment plan. Named tunnels have exact-hostname
HTTP(S) ingress, managed or adopted ownership, retention, and connector token
references. This API does not extend `.forge` syntax.

```ts
import { resolvePlan, emitCloudflareTunnels } from "@forgegraph/adapters";

const plan = resolvePlan(bundle, {
  target: "cloudflare", stage: "preview", stateOwner: "native",
  tunnels: [{
    name: "preview", ownership: "managed",
    ingress: [{ hostname: "preview.example.com", service: "http://localhost:8080" }],
    connector: {
      tokenRef: { source: "external-secret-store", path: "forge/preview/tunnel-token" },
    },
  }],
});
const desiredTunnels = emitCloudflareTunnels(plan);
```

Each tunnel becomes a `cloudflare_tunnel` resource, with a stable
`tunnel-<name>` ID and an app/stage-scoped provider name. Managed resources emit
creation metadata with `config_src: "cloudflare"`. To adopt a remotely managed
Cloudflare tunnel, set `ownership: "adopted"` and `adoptId` to its UUID. Adoption
permits desired ingress configuration updates. It never requests creation, and
`destroyPlan` retains it unless the operator explicitly approves its resource
ID. Managed tunnels can opt into retention with `retain: true`.

Ingress preserves operator order and ends with `http_status:404`. Names must be
lowercase DNS-style identifiers. Hostnames are case-normalized, exact DNS
names; duplicates across the plan are rejected. Origins accept HTTP and HTTPS,
including private hosts and explicit ports, but reject credentials, non-root
paths, queries and fragments. There is no wildcard, path routing, TLS bypass,
or SSH ingress support in this slice.

The connector projection returns `cloudflared` and an argument array, including
`--token-file /run/secrets/tunnels/<name>.token`. An executor must materialize
that file from the referenced secret store, enforce mode `0600` and restrict
its parent directory, then pass the arguments directly without a shell. The
projection does not materialize the file or start the process. Never put a
token value in `tokenRef.path`; it identifies an external secret location.
Connector credentials remain separate from Worker application secret bindings.

The projection produces desired state only. It does not create/update Cloudflare
resources, retrieve tunnel tokens, manage DNS routes or Access policies, start
connectors, or claim that ingress is reachable or healthy. Configure those
through a separate executor before treating a tunnel as delivered. Native
projection requires the native state owner. Terraform plans report an explicit
unsupported tunnel entry, and AWS/self-hosted plans reject tunnel requests;
no cross-target portability is claimed. Empty tunnel options preserve existing
plans.

## Native reconciliation and connector execution

`reconcileTunnel` and `CloudflareTunnelApi`, exported from the adapters root and
`@forgegraph/adapters/tunnel-reconcile`, execute the remote configuration.
The caller supplies a persistent `TunnelJournal` with cross-process exclusive
execution and a `TunnelSecrets` writer for its existing external secret store.
The journal key is the app/stage-scoped provider name. Managed creation journals
the tunnel ID before configuring ingress or storing the connector token. Retries
reuse that ID; a name collision without a journal requires explicit adoption or
journal recovery. A crash between Cloudflare creation and journal persistence
therefore stops for recovery instead of silently claiming an existing resource.

Adoption checks the remote management mode and refuses ingress hostnames outside
the declared scope. Reconciliation preserves provider settings outside ingress.
Configuration comparison ignores JSON object-key ordering. This executor never
deletes tunnels or writes DNS/Access policies: the existing controllers own those
resources. Route publication must be reconciled separately with their owner;
the executor's `dns: "external"` and `access: "external"` results do not certify
that routing or protection exists. Serialize all writers for a tunnel through
the same journal; locking only this executor cannot fence other controllers.

Cloudflare requests use a secret-store token callback, a fixed HTTPS API origin,
no redirects, a 30-second timeout, bounded response bodies and redacted errors.
Connector tokens are written to secret storage and never included in the result.
An HTTP/configuration or credential failure keeps delivery incomplete.

`startTunnelConnector` is a Node-only export at
`@forgegraph/adapters/tunnel-connector-node`; it is intentionally absent from the
portable adapters root. It reads the stored credential, creates a fresh private
directory (`0700`) and exclusive token file (`0600`), and starts `cloudflared`
without a shell. It passes the file path rather than the token in argv and drops
child output. A caller-selected loopback metrics port must be free before launch;
the caller must exclusively allocate that port to prevent competing launches.
Readiness waits for `/ready` on that port with a bounded startup deadline.
Cloudflared readiness proves a connector connection, not application health.

The returned handle exposes `ready()`, `exited`, and idempotent `stop()`.
Aborting the supplied signal terminates the process, then force-kills it after
the bounded grace period. Exit removes the credential directory before resolving
`exited`. An owner may explicitly restart after exit and must implement its own
bounded retry policy; this library does not run an unbounded restart loop.
The trusted executable option supports pinned connector installations and tests.

FORG-10's first live target is the **ForgeGraph staging gateway** (the registered
stage is `beta`). The stage currently has no assigned node or gateway origin.
This implementation has local API and real child-process evidence, including
forced shutdown, crash cleanup and restart, but is not live Cloudflare Tunnel
certification. FORG-10 stays open until an explicit staging hostname/origin,
secret-store wiring, actual connector reachability and failure/recovery evidence
are recorded; production promotion is a separate delivery event.
