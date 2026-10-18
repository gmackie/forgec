# RFC 9068 OAuth access-token AuthHost

This opt-in ForgeGraph adapter turns a **cryptographically verified RFC 9068
JWT access token** into the `verifiedOAuth` record consumed by the shared
`Engine.call` operation-security gate (HTTP and MCP). It is not an
authorization server and does not issue tokens.

```ts
import {rfc9068AuthHost, createHttpHandler} from "@forgegraph/runtime";

const auth = rfc9068AuthHost({
  issuer: "https://login.example.com",
  resource: "https://api.example.com/orders",
  algorithm: "RS256",
  publicKeys: operatorPinnedPublicJwks,
  allowedClients: ["verified-agent-client"],
  async resolvePrincipal(subject) {
    // MUST resolve live membership / offboarding / tenant authority from
    // operator-approved PIP or directory data, not user-provided headers.
    return companyDirectory.resolve(subject.issuer, subject.subject, subject.clientId);
  },
});

// The engine must be provisioned with the SAME reviewed security publication.
const handler = createHttpHandler(model, engine, {auth, publication});
```

## Credential acceptance profile

The issuer, resource identifier, algorithm, signing keys, optional client
allowlist and maximum token lifetime are operator-pinned. JWT header `typ`
must be `at+jwt` or `application/at+jwt`; required claims include
`iss`, `aud`, `sub`, `client_id`, `iat`, `exp` and `jti`.
The JWS signature is verified with WebCrypto over the exact signing input;
client-supplied `jwk`, `jku`, `x5u`, `x5c`, critical extensions,
unknown signing keys, `alg=none`, unsupported type, ID token nonce,
unsupported delegated `act` or confirmation `cnf` are rejected.
The resource is checked against the audience. Scope syntax and expiry are
checked before passing immutable values to the runtime.

It deliberately refuses sender-bound (DPoP/mTLS) and delegated tokens.
Use a separate explicitly configured verifier for those, not a fallback
to this Bearer adapter.

**Issuer key rotation:** An operator or vetted discovery-admission workflow
must replace the pinned keys. Tokens cannot set signing-key download URLs,
and this adapter does not dynamically fetch JWKS. Key revocation requires
rotating pinned keys and/or independently rechecking revocation status.
A signature-valid JWT alone does not guarantee an account has not been
deactivated; an authoritative PIP resolver must enforce that.

**Privacy:** Roles, emails, tenant claims and arbitrary authorization hints
in JWTs are not mapped automatically. The trusted `resolvePrincipal` port
must provide tenant and actor, and must fail closed when its authoritative
source is unavailable. Token bytes are never included in the returned
Principal or placed in the Engine context.

**Error handling:** Invalid/expired token, absent authentication, mismatched
issuer/audience, or unsupported `cnf`/`act` are rejected. The transport
must issue RFC 6750 challenges and RFC 9728 resource metadata links as
appropriate. No permission is granted without current PIP/ABAC decisions.

**Note:** The existing `jwtAuth` adapter remains unchanged for legacy or
development integrations; it does not automatically satisfy the opt-in
OAuth-security operation gate.

## Test requirements

`pnpm --filter @forgegraph/runtime test` includes signed RS256 token
fixtures and negative cases for issuer, audience, client, type, key IDs,
unknown signatures, expiration, scope, illegal delegation and tenant-claim
injection. The full ForgeGraph CI matrix checks that the adapter and
runtime can coexist without changing the default security posture.

This does not complete the browser-based OAuth Authorization Code + PKCE
client, external authorization-server configuration, or live enterprise
provider integration; those are independently deployable pieces.
