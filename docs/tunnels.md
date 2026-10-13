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

This slice produces desired state only. It does not create/update Cloudflare
resources, retrieve tunnel tokens, manage DNS routes or Access policies, start
connectors, or claim that ingress is reachable or healthy. Configure those
through a separate executor before treating a tunnel as delivered. Native
projection requires the native state owner. Terraform plans report an explicit
unsupported tunnel entry, and AWS/self-hosted plans reject tunnel requests;
no cross-target portability is claimed. Empty tunnel options preserve existing
plans.
