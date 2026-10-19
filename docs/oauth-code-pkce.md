# OAuth 2.0 registered-agent public client: Authorization Code + PKCE

`oauthPkceClient` provides a host-side Authorization Code flow to
**existing authorization servers** under RFC 6749, RFC 7636, RFC 8707,
and RFC 9207. It does not implement an OAuth server, invent credentials,
or treat an API's untrusted metadata as an authorized issuer.

## Prerequisites

The company pre-registers the client and HTTPS redirect URI with the AS.
The trusted operator must pin `issuer`, `authorizationEndpoint`,
`tokenEndpoint`, `clientId`, `resource` and the approved scopes. The
configured issuer must support the public-client/token endpoint profile
(usually `token_endpoint_auth_method=none`); confidential clients require
a separate token-endpoint authentication adapter, not pretending to be public.

```ts
const app = oauthPkceClient({
  issuer: "https://login.example.com",
  clientId: "registered-agent",
  authorizationEndpoint: "https://login.example.com/oauth2/authorize",
  tokenEndpoint: "https://login.example.com/oauth2/token",
  resource: "https://api.example.com/orders",
  redirectUri: "https://client.example.com/oauth/callback",
  allowedScopes: ["orders:read", "orders:write"],
  // An atomic durable store, e.g. D1/DO. Never in a model prompt.
  store: {
    put: pending => encryptedDurableState.putIfAbsent(pending.state,pending),
    take: state => encryptedDurableState.takeExactlyOnce(state),
  },
});

const start = await app.start(["orders:read"], verifiedBrowserSessionBinding);
// Redirect the human's actual browser to start.url. Do NOT follow this URL
// as an agent asking the user for login credentials.
const result = await app.callback(fullHttpsCallbackUrl, verifiedBrowserSessionBinding);
// Only the trusted credential service receives result.accessToken.
```

## Security behavior

- Cryptographically random, independent state and code verifier; S256
  challenge; exact registered HTTPS redirect URI; single-use durable state.
- Scope is selected from an explicit client allowlist, not every advertised
  API scope. The target RFC 8707 resource is included in authorization
  and token requests.
- State is bound to a verified, high-entropy browser-session identifier and
  atomically consumed before any code exchange; duplicate callbacks
  and expired state cannot exchange an authorization code twice.
- RFC 9207 issuer response parameter `iss` is required by default and must
  exactly match the pinned AS. Disabling it requires an independently reviewed
  redirect URI used by exactly one AS; never share such a callback across
  multiple issuers without issuer identification.
- No redirects from token endpoint; HTTPS and origin pinning; bounded JSON;
  no cookies on token exchange; short deadline and no body logging.
- The returned `scope` can only be equal to or narrower than the request.
  Refresh tokens are rejected by this minimal public-client profile rather
  than silently stored by the app.
- Token bytes must remain within the host's secure credential broker and
  never be sent to an LLM, agent tool description, audit log, or unrelated API.
- The resource server still independently verifies each bearer token under
  RFC 9068, RFC 7662 or another configured issuer-specific profile, and
  enforces Gatekeeper/ABAC permission after token validation.
- An unsupported scope, issuer/redirect mixup, replay, CSRF, unexpected
  callback extension, token response expansion or missing storage authority
  must fail closed.

## Limitations

This is not a complete OAuth credential broker or browser UI: the host owns
safe login redirects, security headers, encrypted pending-state storage,
user session binding, session cleanup, token lifecycle, client registration
and end-user revocation. A durable pending-state implementation must bind
the pending authorization to the *correct human browser session*; a state
token alone must not connect Alice's callback to Bob's session.

For details-bearing high-risk authorization requests, add PAR (RFC 9126),
JAR (RFC 9101) and RAR (RFC 9396) as independently reviewed profiles.
The code intentionally does not accept experimental OAuth draft metadata
as permission to expand scope.

CI runs signed/unsigned state and PKCE challenge fixtures, issuer mixup,
scope escalation, token endpoint confusion, exact callback matching and
replay tests.
