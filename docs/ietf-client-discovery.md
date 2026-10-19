# Agent API discovery with existing IETF standards

`@forgegraph/interfaces/discovery` provides an opt-in, one-hop client
that composes:

* RFC 9727 + RFC 9264 API catalogs (JSON Linkset)
* RFC 8631 `service-desc` / `service-doc` link relations
* RFC 9728 OAuth protected-resource metadata
* RFC 8414 OAuth authorization-server metadata
* RFC 8707 exact resource indicators and RFC 7636 S256 requirements

It does not replace OAuth, register an agent automatically, or add a trust-on-first-use path.

## Example

```ts
import { discoverApi } from "@forgegraph/interfaces/discovery";
import { oauthPkceClient } from "@forgegraph/runtime";

const found = await discoverApi({
  origin: "https://api.example.com",
  resource: "https://api.example.com/orders",
  issuer: "https://login.example.com/acme",
  allowedOrigins: ["https://api.example.com","https://docs.example.com"],
  approvedScopes: ["orders:read"],
});

// found.oauth supplies validated, pinned issuer/AS endpoints.
// It has NO OAuth credentials or user permissions.
const client = oauthPkceClient({
  issuer: found.oauth.issuer,
  authorizationEndpoint: found.oauth.authorizationEndpoint,
  tokenEndpoint: found.oauth.tokenEndpoint,
  resource: found.oauth.resource,
  clientId: "registered-public-agent",
  redirectUri: "https://client.example.com/callback",
  allowedScopes: ["orders:read"],
  store: serverSideEncryptedSingleUseState,
});
```

## Trust and security

1. Configuration is operator-controlled. The catalog origin, protected resource
   identifier, allowed catalog-link origins and OAuth issuer are pinned before
   discovery begins. The client never accepts a new issuer merely because a
   catalog or 401 response mentions one.
2. The catalog parser accepts bounded Linksets and returns **suggestions**.
   It does not traverse nested catalogs, fetch referenced OpenAPI documents,
   automatically import routes, enroll clients, or grant permissions.
3. The resource and issuer metadata values must match the exact pinned
   identifiers. Auth endpoints and JWKS URI must be on the pinned issuer's
   origin in this deliberately strict profile.
4. Requests use HTTPS, `redirect: "manual"`, exact origins, short timeouts,
   strict JSON/linkset media types and bounded bytes. Client secrets and bearer
   credentials are never sent during discovery.
5. The AS must advertise Authorization Code and PKCE S256. The AS's published
   scopes may be broader than the application allowlist, but the client's
   requested scopes must be known if the resource advertises a scope catalog.
6. Hostnames `localhost`, internal/local suffixes and IP literals are
   refused. This is *not* sufficient SSRF protection against DNS rebinding:
   deployments that ingest untrusted catalogs must also use controlled
   outbound DNS resolution and network-level private-address denial.
7. These results are informative. After a human grants consent, the API still
   verifies every token signature or introspection result, resource audience,
   scope, subject/client, sender constraint, tenant membership and ABAC policy.

The discovery surface is public data by default. Internal catalog and OpenAPI
projection require independent authentication, per-tenant filtering and
operator review; this client intentionally does not auto-forward OAuth tokens
to metadata links.

## Limits

This profile does not implement arbitrary issuer delegation, an automatic
private OpenAPI fetch, dynamic client registration, the OAuth Client ID
Metadata Document Internet-Draft, mTLS or an OAuth authorization server.
That keeps RFC-based interoperability optional and auditable.

`pnpm --filter @forgegraph/interfaces test` exercises path insertion, trusted
three-request discovery, malicious Linksets, redirect/media/byte guards,
issuer substitution, unauthorized scopes and PKCE downgrades.
