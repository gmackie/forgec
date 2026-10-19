# Standards-first OAuth interoperability acceptance fixture (X1)

`packages/interfaces/test/oauth-e2e.test.ts` is an executable, opt-in
synthetic interop fixture that composes the existing generated API model with
published IETF and OpenID authorization interfaces.

## Scenario

1. The API serves RFC 9727/9264 `/.well-known/api-catalog` (GET/HEAD)
   and RFC 9728 `/.well-known/oauth-protected-resource`, without publishing
   unreviewed private inventory.
2. The registered agent client prepares Authorization Code with PKCE S256,
   a browser-session-bound and single-use state, exact redirect, minimal
   `contacts:read` scope and the RFC 8707 resource indicator. The mock AS
   verifies the posted code verifier against the original challenge.
3. A test AS signs an actual RS256 RFC 9068 access token: `typ=at+jwt`,
   pinned issuer and `aud`, `sub`, `client_id`, `iat`, `exp`, `jti`,
   scope. The resource's strict AuthHost cryptographically verifies it and
   resolves an issuer-qualified subject to trusted tenant/actor/PIP facts.
4. HTTP GET of the existing Contact resource passes only with the right
   scope **and** an AuthZEN allow response. HTTP PATCH with read-only scope
   returns a 403 `insufficient_scope` challenge.
5. A write-scope token still cannot write when the policy denies. Switching
   the injected PDP to allow permits the intended write; the same canonical
   operation can be invoked through the MCP tool, with the same OAuth gate.
6. A revoked directory membership, invalid bearer token and disconnected
   PDP fail closed. The MCP listing cannot advertise operations for which
   this token lacks required scopes.

## Trust model

The test authorization server and the AuthZEN PDP are **injected,
deterministic mock transports**. The JWT signature and PKCE challenge are
cryptographically genuine, but the consent UI, user authentication ceremony,
OAuth issuer metadata onboarding, account suspension source, durable D1
grant store, token revocation transport and production Gatekeeper Rego/PIP
are **not live third-party integrations** in this test.

Do not call this an independently certified OAuth issuer, a full AuthZEN
conformance result, or proof of enterprise SSO interoperability. The test
proves that the discrete ForgeGraph adapters compose with the same engine
across HTTP and MCP, and fails if transport scope or policy is skipped.

## Run and merge gates

```sh
pnpm --filter @forgegraph/interfaces test
pnpm --filter @forgegraph/runtime test
pnpm -r run build
```

Review and merge the RFC 9068 AuthHost and PKCE client dependencies first.
This X1 PR should be retargeted to `main` after the PKCE dependency has
passed CI and merged; its final head needs a passing full CI run. The separate
Gatekeeper PRs must then supply their trusted OAuth + AuthZEN runtime
integration before a real multi-repository acceptance claim is possible.
