# AuthZEN remote PDP integration (opt-in)

The ForgeGraph runtime now offers `authzenAuthorizer` as a **remote PDP
client**, implementing the OpenID AuthZEN Authorization API 1.0 access evaluation
request/response. This is a narrow, fail-closed interoperability adapter,
not a credential validator or a replacement for the existing Gatekeeper engine.

```ts
import {authzenAuthorizer} from "@forgegraph/runtime";
engine.gatekeeper.authorizer = authzenAuthorizer({
  endpoint: "https://pdp.example.com/access/v1/evaluation",
  epoch: 1,
  credential: async () => tokenFromServerSideCredentialService(),
});
```

The **PEP must have independently authenticated the caller** into Forge's
trusted `CallContext`. The PDP access token is server-owned. An AuthZEN PDP
used here must itself trust this client as a PEP, independently validate its
authentication, and retrieve current tenant/resource facts from authoritative
PIPs. Never expose the PDP credential to a browser, model prompt, MCP tool
description or OpenAPI document. This does **not** interoperate with Gatekeeper's
restricted self-evaluation interface unless that server has been configured with
a separate, appropriately authenticated trusted-PEP integration.

The adapter sends only stable subject, tenant, operation, resource ID, purpose
and operation kind. It intentionally does not serialize record bodies,
PII, PIP values or arbitrary request-provided context. The external PDP must
be able to decide from the stable resource identifier or deny.

`liveAttributes: true` disables Gatekeeper decision caching; no local row
predicate is declared, so lists require per-record policy checks rather than
unverified authorization pushdown. Only the standard `decision: boolean` is
honored. Unrecognized obligations or claims cannot be silently treated as
satisfied. Timeout, network failure, non-200, MIME mismatch, malformed responses
or server-side credential failure fail closed with DependencyUnavailable.
Never silently fall back to a local allow policy.

Scope validation, RFC 9068 access-token validation, DPoP, RFC 8707 audience
checks and actual OAuth token acquisition belong to the verified `AuthHost`
or trusted ingress PEP, not this adapter. A boolean AuthZEN allow alone does
not supply missing OAuth permissions.

Rollback: remove the remote authorizer and restore the previous release-pinned
authorizer. Do not replace a required PDP with the permissive null authorizer.
