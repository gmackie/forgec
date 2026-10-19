# Standards-first API discovery publication

The ForgeGraph runtime can **opt in** to publishing two independent IETF
metadata protocols without altering the ForgeGraph-specific `/forge/discovery`
contract or granting permission to any existing operation.

- **RFC 9727 / RFC 9264 / RFC 8631:** `GET` and `HEAD /.well-known/api-catalog`.
  The response is a JSON Linkset with a catalog `item` relation and optional
  `service-desc` / `service-doc` for explicitly reviewed public API entries.
  The `HEAD` response includes an `api-catalog` `Link` header.
- **RFC 9728:** `GET /.well-known/oauth-protected-resource[/resource-path]`.
  The document publishes the exact protected resource identifier, pinned AS
  issuer identifiers, supported scopes and bearer header transport.
  Ordinary OAuth 401 responses include a `resource_metadata` challenge when
  the host uses an OAuth scheme; dev-header authentication never does.
- Existing `/forge/discovery`, `/forge/openapi.json` and API operations
  **remain authenticated exactly as before**. An explicit catalog link to a
  protected OpenAPI document does not make the document public.

## Deployment configuration

The trusted application/edge owner provides an `ApiPublicationProfile` to
`createHttpHandler(model, engine, {auth, publication})`. Example:

```ts
const publication: ApiPublicationProfile = {
  version: "forge-api-publication/1",
  resource: "https://api.example.com/v1",
  authorizationServers: ["https://login.example.com"],
  scopesSupported: ["orders:read", "orders:write"],
  services: [{
    endpoint: "https://api.example.com/v1/orders",
    serviceDesc: "https://api.example.com/forge/openapi.json",
    visibility: "public",
  }],
  operations: {
    "acme.commerce/_/Order.list": {visibility: "oauth2", scopes: ["orders:read"]},
  },
};
```

The operation key is **illustrative**: it must match an actual canonical
operation identifier from the loaded Forge model. Unknown IDs, unknown scopes,
inconsistent public/private visibility and malformed or noncanonical HTTPS
URLs fail startup. A profile can omit `operations` in publication-only mode.
The services marked `private` are never serialized into the public catalog.

The resource identifier is an RFC 8707 value. When it has a path suffix,
RFC 9728 metadata is located at `/.well-known/oauth-protected-resource`
followed by that suffix. These are origin-rooted endpoints: host-level routers,
Cloudflare assets, API gateways and reverse proxies MUST forward the precise
well-known paths to the application. The publisher rejects requests with a
different origin from its configured resource.

**Security limitation:** This PR ships *metadata publication*, not an OAuth
authorization server, Authorization Code exchange, access-token scope checker,
DPoP/mTLS verifier, or RAR runtime. Declared `operations` are validated
contracts for future enforcement; until that enforcement integration lands,
operators must ensure the metadata describes what their existing `AuthHost`
and external controls actually enforce. Do not mark internal services public
or put sensitive OpenAPI documents at anonymous URLs.

Test: `pnpm --filter @forgegraph/runtime test` and root conformance CI.
References: RFC 8615, 8631, 9264, 9727, 9728 and 8707.
