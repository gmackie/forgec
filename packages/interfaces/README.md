# @forgegraph/interfaces

Non-Effect interfaces over one operation model (M14). Everything here is a projection of the
contracts the runtime enforces; nothing adds an operation the deployment does not serve.

| entry | what |
|---|---|
| `@forgegraph/interfaces/rpc` | `localCallable(engine, principal)` and `httpCallable({ baseUrl, credential, expect })`: one unary envelope, typed outcomes (`ok` / `error` Problem / `invocationFailed`). A remote binding checks `/forge/discovery` digests before its first call. |
| `@forgegraph/interfaces/mcp` | `createMcpServer({ engine })` + `mcpHttp(server)`: MCP tools/resources generated from the OpenAPI projection, listed per identity and purpose, every call re-authorized by the engine. Mount with `createHttpHandler(model, engine, { auth, mounts: { "/forge/mcp": mcpHttp(server) } })`. |
| `forge-api` | Generic CLI (`bin/forge-api.mjs`): `forge-api Customer.create --set code=ACME --set name=Acme --yes`, `--file`, `--stdin`, `--dry-run`, `operations`, `discovery`. Exit codes 0 ok · 2 usage · 3 problem · 4 transport · 5 contract mismatch · 6 mutation refused · 7 authentication. |
| `sdk-python/forge_api.py` | Standard-library client; money/decimals as `Decimal`; `ProblemError` vs `InvocationFailed`. |
| `sdk-go/forge` | Go client; `json.Number`, strings for money; `*ProblemError` vs `*InvocationFailed`. |

Cross-language conformance (`test/sdk-conformance.test.ts`) runs the same scenario through the
TypeScript, Python and Go clients against a live Node host and compares canonical values.

Importing a vendor API: `forgec import-openapi spec.json --package @vendor/name --out vendor/ --pin URL=FILE[@SHA256] --allow-host api.vendor.example`.
The importer never fetches; see `FOREIGN_IDS.md` and `import-report.json` in the output.

## GraphQL projection

`@forgegraph/interfaces/graphql` projects the bundle's generated OpenAPI contracts
into GraphQL, preserving canonical runtime operation IDs. Resource create/get/
find/list/update/delete/restore/transition operations and HTTP-exposed functions
are supported. Other operation kinds are reported in `projection.diagnostics`.
Unsupported JSON schema shapes fail schema construction with a diagnostic rather
than degrading to an untyped field. References remain IDs; joins and nested
relationship resolvers are outside this initial profile.

```ts
import { projectGraphQL, graphqlHttp, diffGraphQL } from "@forgegraph/interfaces/graphql";
import { createHttpHandler } from "@forgegraph/runtime";

const mapping = {
  operations: {
    "@kanbanger/issues/_/Issue.get": "issue",
    "@kanbanger/issues/_/Issue.create": "issueCreate",
    "@kanbanger/issues/_/Issue.list.byTeam": "issues",
  },
  types: { IssueRecord: "Issue" },
  fields: { IssueRecord: { status: "state" } },
};
const projection = projectGraphQL(engine.model.bundle, mapping);
// projection.sdl is deterministic and can be checked into a client's contract.
const handler = createHttpHandler(engine.model, engine, {
  auth,
  mounts: { "/forge/graphql": graphqlHttp(engine, mapping) },
});
```

POST `{ "query": "{ issues(team: \"ENG\", limit: 20) { items { id title } next } }" }`
with the host's usual authentication and `X-Forge-Purpose` header. `cursor` accepts
the previous page's opaque `next` value; `limit` is 1–100. Mutations take an `input`
body, plus path arguments and `expectedVersion` where required by the contract.
Function body fields map back to the original function envelope. Functions are
always GraphQL mutations because a GET binding alone does not prove purity.

Resolvers use `localCallable(engine, principal)` and therefore the same tenant,
purpose, capability, version, idempotency, and validation checks as other interfaces.
`executeGraphQL(projection, callable, request, options)` also accepts an authenticated
`httpCallable`. Client variables never set the trusted principal. Business errors
appear in GraphQL `errors[].extensions.code/status`; internal error details are
not returned. Output fields are nullable because purpose surfaces can omit them.
The schema is a static contract, not a principal-specific field discovery API.

Default identities encode canonical names without lossy punctuation removal.
Explicit mappings give public contracts readable or legacy names; collisions and
unknown mappings fail construction. Component mappings apply to inputs and outputs;
input type names add `Input`. Enum identities and values are stable encoded names.
Forge integers use `ForgeInteger` (safe 53-bit integers); exact decimals remain
strings. `diffGraphQL(before, after)` reports GraphQL breaking/dangerous changes
and changes to canonical resolver bindings even when the SDL is unchanged.

The HTTP mount accepts POST only, rejects batches and bodies above 1 MiB, and
bounds parsing, expanded selections, nesting, and root fields before invocation.
It must be installed behind the existing authenticated host. There are no
subscriptions, arbitrary SQL resolvers, or implicit scans. This is an opt-in
interface package; it does not add a GraphQL route to every host automatically.

See `examples/kanbanger-graphql` and `test/graphql.test.ts` for the issue-tracker
compatibility fixture, cursor pagination, lifecycle actions, and permission tests.
