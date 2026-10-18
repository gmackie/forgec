# OAuth bearer challenges for all protected resource paths

RFC 6750 requires a challenge on a protected resource's HTTP 401 response.
The ForgeGraph handler previously published the RFC 9728
`resource_metadata` challenge only when the incoming URL exactly equaled
the configured OAuth resource identifier. This omitted challenges on common
subpaths such as `/v1/orders/123` when the protected resource identifier
was its parent origin.

The opt-in OAuth host now:

- Adds `WWW-Authenticate: Bearer resource_metadata="..."` on all
  authenticated paths returning a missing-credential 401 when a reviewed
  RFC 9728 resource publication is configured, without asserting a second
  issuer for the subpath.
- Adds `error="invalid_token"` when a bearer credential was presented and
  the authenticator rejected it; absent credentials do not get a misleading
  `invalid_token` error.
- Preserves standard `error="insufficient_scope"` and the reviewed
  operation's requested scopes, with the same protected-resource metadata
  pointer when configured.
- Uses plain `Bearer` challenges if the publisher has no reviewed OAuth
  metadata. The explicit `dev-header` mode does not claim OAuth semantics.
- Exposes `WWW-Authenticate` for origins approved by the application's
  existing CORS configuration. No new origin is allowed automatically.

The trust-pinned issuer and operation profile still come from the configured
publication. This change provides error metadata only; it never widens
access or triggers an automatic OAuth scope grant.

Test with `pnpm --filter @forgegraph/runtime test` and full CI. Existing
published APIs should retain operation results, status codes and error bodies.
