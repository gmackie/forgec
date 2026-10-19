# Redacted public OpenAPI for standards-compliant agent discovery

OAuth access to one operation does **not** imply permission to read all
unreviewed operations or schemas in the generated app bundle.

The `projectReviewedPublicOpenApi` helper constructs a new OpenAPI 3.1
document containing only the operations explicitly marked `public` or
`oauth2` in `forge-api-publication/1`. It strips unused schemas,
transitively resolves only reviewed local component references, rejects
external/unresolved references and dangerous metadata, removes examples,
defaults and internal `x-*` extension data, and projects exact reviewed
OAuth scopes via `projectOpenApiOAuthSecurity`.

The source bundle is never mutated.

## Opt-in publisher

```ts
const handler=createHttpHandler(model,engine,{
  auth: verifiedOAuthHost,
  publication: reviewedApiPublication,
  publicOpenApiServer: {
    issuer: "https://login.example.com",
    authorizationUrl: "https://login.example.com/authorize",
    tokenUrl: "https://login.example.com/token",
    scopeDescriptions: {"orders:read":"Read orders"},
  },
});
```

Publishing a redacted OAS requires:

- A real opt-in `EngineOptions.oauthPublication` with an enforced
  operation-level OAuth gate and a configured PDP.
- Identical runtime and publisher resource identifier, issuer list,
  supported scopes and operation requirements.
- An explicit reviewed `service-desc` link to the exact origin's
  `/forge/openapi.json`.
- A trusted authorization-server configuration, not endpoints taken
  from untrusted runtime headers or agent suggestions.

Only then does `GET/HEAD /forge/openapi.json` become public and
cacheable. Otherwise the raw OpenAPI document stays blocked in OAuth
security mode, including through MCP resources, rather than leaking
private schemas. The public RFC 9727 catalog and RFC 9728 metadata remain
available for OAuth bootstrap.

The public schema includes only necessary transitive local components,
not unrelated private component definitions. A caller may still need a
proper OAuth token to invoke the advertised operation. Publishing its
contract does not grant that token, and Gateway/ABAC authorization remains
mandatory.

## Security limits

This is deliberately conservative: only local component references under
the supported OpenAPI component groups are allowed. Unsupported/external
references and dynamic references fail publication. Schema defaults,
examples, custom extension annotations, private operations, and unreviewed
PathItem fields are excluded. A service needing more expressive public
documentation must explicitly extend the reviewed projection model and
its negative tests.

The generated OpenAPI currently publishes a minimal public `info` title
and version rather than inheriting potentially private bundle metadata.
It is distinct from a principal-specific private description and does not
replace Gatekeeper's permission-filtered private catalog.

CI: `pnpm --filter @forgegraph/runtime test`,
`pnpm --filter @forgegraph/interfaces test`, full build and differential
matrix. Negative tests include external references, missing components,
previous security declarations, private schemas, unsupported operation IDs
and raw endpoint leakage.
