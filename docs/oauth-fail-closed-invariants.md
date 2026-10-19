# OAuth-protected runtime fail-closed boundaries

The opt-in `EngineOptions.oauthPublication` security profile **requires an
installed policy decision point** (`engine.gatekeeper.authorizer`). If none
is present, every non-maintenance invocation fails; the legacy no-authorizer
allow behavior applies only to engines **without** the opt-in security
publication.

All `Engine.callInternal` calls also apply the same published OAuth gate.
Trusted maintenance contexts remain a separate, privileged deployment
capability and must never be exposed through HTTP, MCP, user workflows,
request headers or an agent-supplied object.

An OAuth access token sufficient to invoke one operation is **not**
automatically permission to read the complete API inventory, workspace
descriptor or raw OpenAPI component schemas. With `oauthPublication`
enabled, `/forge/discovery`, `/forge/workspace.json` and
`/forge/openapi.json` deny raw access by default. Likewise the MCP
`forge://discovery` and `forge://openapi` resources and unfiltered
resource templates aren't advertised, and raw read attempts fail. MCP
tools/list remains filtered by the current token scope AND PDP policy.

Public `/.well-known/api-catalog` and RFC 9728 metadata are unaffected.
A separate, operator-reviewed and redacted OpenAPI projection can be
published at a known service-desc URL; the generic raw bundle must not
silently be used for that. An authenticated tool catalog can still return
reviewed operations without disclosing every internal schema.

When a runtime security profile and public publisher are both present,
the constructor rejects mismatched resource IDs, OAuth issuers, supported
scopes and per-operation security requirements, instead of publishing
one contract and enforcing another.

The AuthZEN client rejects a positive decision carrying unrecognized
response fields, so nonstandard obligations/advice cannot be silently
treated as fulfilled. Richer AuthZEN extension support requires a
separate explicit implementation and conformance tests.

## Verification

```bash
pnpm --filter @forgegraph/runtime test
pnpm --filter @forgegraph/interfaces test
pnpm -r run build
```

Negative tests cover missing PDP, direct/nested operation requests,
raw metadata disclosure through HTTP and MCP, cross-profile drift,
and unimplemented positive AuthZEN extensions.

This is a tightening of the explicit OAuth mode, not a change to
non-OAuth engines or a claim that external Gatekeeper PDP/IdP integration
is automatically configured.
