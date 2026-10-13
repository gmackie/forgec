# Application sessions and API tokens

`workspaceAuth` from `@forgegraph/runtime/workspace-auth` is a portable `AuthHost`
for Node and Workers. Pass it to `createNodeHost({ auth, ... })` or
`createWorker(bundle, { auth, ... })`. Deployment configuration selects a single
workspace; request headers, query parameters, session active-organization fields
and token claims cannot change that selection.

```ts
const authHost = workspaceAuth({
  workspaceId: deployment.workspaceId,
  issuer: "my-application",
  sessionOrigins: ["https://app.example.com"],
  getSession: input => auth.api.getSession(input),
  membership: (actor, workspace) => applicationMemberships(actor, workspace),
  verifyApiToken: token => applicationTokens.verify(token),
});
```

The application owns credential verification and membership policy. The adapter
uses BetterAuth's `getSession` shape and requests `disableCookieCache: true` so a
revoked session cannot survive in a signed cookie cache. The provider must check
current server-side session state. Only Cookie is forwarded to session lookup;
caller identity/workspace headers are excluded. Session/user identifiers must
match and expiration must be valid and in the future. Cookie-authenticated writes and WebSocket upgrades
require an explicit allowed Origin. Missing or untrusted origins fail closed;
non-browser callers should use an API token. Deployment CORS configuration must
also allow the intended browser origin.

API token verification must check an opaque token against its authoritative
store (prefer a constant-time hash lookup), returning actor, workspaceId,
expiresAt, revoked and purposes. Never simply decode an unverified token.
`expiresAt` is a Date, ISO timestamp, or milliseconds since epoch. Tokens cannot
cross workspaces, and an invalid Authorization header never falls back to a
valid session cookie. Credential values are never returned in principals.

Every invocation checks an active membership whose actor and workspace match
the deployment. Map application roles to explicit invocation purposes in that
lookup; the adapter does not invent role privileges. Token purposes are
intersected with membership purposes. An empty list grants no explicit purpose.
`x-forge-purpose` remains subject to the runtime's purpose check. Issuer and
optional workload come from deployment configuration. Provider errors are
sanitized and fail closed; no credentials or database diagnostics reach clients.

This is an adapter, not a session store, login endpoint, token minting service or
production authentication activation. Keep those under the application's owner.
