# OpenAPI OAuth security projection (strict, opt-in)

`projectOpenApiOAuthSecurity(openapi, validatedPublication, trustedOAuthServer)`
projects security declarations into a *new*, immutable OpenAPI 3.1 document.
It complements the published RFC 9727/RFC 9728 metadata added in #225.

- A separate, reviewed `forge-api-publication/1` profile must classify **every**
  canonical `operationId` in the OpenAPI document as `public` or `oauth2`.
  Unknown, duplicate, omitted or extra operation IDs fail projection.
- OAuth2 operations receive the exact `security: [{forgeOAuth: [scopes...]}]`;
  explicitly public operations receive `security: []`.
- The security scheme is OpenAPI 3.1 `type: oauth2`, authorization-code
  flow, with *explicitly pinned* authorization and token endpoint URLs.
  The issuer is independently pinned and must occur in the resource publisher's
  allowed `authorizationServers`; the endpoints must be on its origin.
- Existing security declarations are not silently overwritten.
- `private` operations are intentionally rejected: a separate authenticated
  private-document and schema-redaction model is required to avoid leaking
  sensitive component schemas.
- The generated bundle and its canonical OpenAPI document remain unchanged.

**Important security gate:** This projector is a **pure artifact builder**, not
a token verifier or runtime enforcement middleware. Nothing enables it on live
`/forge/openapi.json` by default. The application must first deploy an
`AuthHost` or PEP that independently validates access tokens, target audience,
scopes and current Gatekeeper/ABAC policy, and then explicitly choose to serve
the projected document. Publishing OAuth scopes in an OpenAPI document without
runtime enforcement would be misleading and unsafe.

OAuth Authorization Code usage by clients additionally requires PKCE and
redirect-state checks; these are not automatically enforced by the projection.
The RFC 8707 `resource` parameter is part of the client authorization request
and the protected-resource identity, not an implied claim derived from OpenAPI.
The project does not create an OAuth authorization server or a client
registration.

Tests: `pnpm --filter @forgegraph/runtime test`, full CI.
Standards: OpenAPI 3.1, RFC 6749, 7636, 8414, 8707, 9728.
