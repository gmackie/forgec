# Opt-in OAuth runtime operation enforcement (F4)

`checkPublishedOAuth` enforces a reviewed Forge `forge-api-publication/1`
contract **at the shared Engine.call boundary**, before dispatch, for every
non-maintenance call. HTTP and MCP pass the same host-verified access-token
facts to that boundary; a tool that was listed earlier cannot bypass it.

Configure a validated `ApiPublicationProfile` on `EngineOptions.oauthPublication`,
and publish it separately on `createHttpHandler(..., {publication})`. No
issuer or token verifier is enabled automatically.

`AuthHost.authenticate(Request)` must validate the OAuth access token
(signature or RFC 7662 introspection, token profile, issuer, resource
audience, expiry, client, optionally proof of possession). It then supplies
the **trusted result**, never the raw token:

```ts
return {
  tenant: verifiedTenantFromPip,
  actor: verifiedSubject,
  verifiedOAuth: {
    tokenType: "access-token",
    issuer: verifiedIssuer,
    audiences: verifiedAccessTokenAudiences,
    scopes: verifiedAccessTokenScopes,
    clientId: verifiedClientId,
    expiresAt: verifiedExpiryMs
  }
};
```

Never populate `verifiedOAuth` from unverified JWT decoding or an HTTP header,
MCP message, prompt, or agent-provided JSON. This shape is NOT proof of
verification: authentication is the application host's responsibility.

Operations without a reviewed security entry, and private operations, are
denied. Public operations do not require OAuth but still pass the ordinary
host authentication and resource policy engine. OAuth operations require
matching issuer, exact resource audience, client identity, unexpired access
token, and **all** required scopes. A scope alone never bypasses the
Gatekeeper/Rego/ABAC engine.

MCP tools/list is filtered by the current verified OAuth permissions and is
not cached for OAuth-secured engines; tools/call and resource reads still
recheck the shared engine gate. The raw OpenAPI MCP resource is hidden when
publication enforcement is active until an independently reviewed
identity-filtered schema is available. Direct Engine.call callers must be
trusted runtime integrations, not arbitrary user-provided contexts.

This is the runtime authorization-enforcement slice, not an AS, token
exchange server, PKCE implementation, or an OAuth client.

**Rollback:** Remove the opt-in security mode only by restoring the previous
trusted deployment/policy release; it is never an acceptable runtime fallback
for an enforced tenant if OAuth introspection or PDP connectivity fails.
