# @forge/interfaces

Non-Effect interfaces over one operation model (M14). Everything here is a projection of the
contracts the runtime enforces; nothing adds an operation the deployment does not serve.

| entry | what |
|---|---|
| `@forge/interfaces/rpc` | `localCallable(engine, principal)` and `httpCallable({ baseUrl, credential, expect })`: one unary envelope, typed outcomes (`ok` / `error` Problem / `invocationFailed`). A remote binding checks `/forge/discovery` digests before its first call. |
| `@forge/interfaces/mcp` | `createMcpServer({ engine })` + `mcpHttp(server)`: MCP tools/resources generated from the OpenAPI projection, listed per identity and purpose, every call re-authorized by the engine. Mount with `createHttpHandler(model, engine, { auth, mounts: { "/forge/mcp": mcpHttp(server) } })`. |
| `forge-api` | Generic CLI (`bin/forge-api.mjs`): `forge-api Customer.create --set code=ACME --set name=Acme --yes`, `--file`, `--stdin`, `--dry-run`, `operations`, `discovery`. Exit codes 0 ok · 2 usage · 3 problem · 4 transport · 5 contract mismatch · 6 mutation refused · 7 authentication. |
| `sdk-python/forge_api.py` | Standard-library client; money/decimals as `Decimal`; `ProblemError` vs `InvocationFailed`. |
| `sdk-go/forge` | Go client; `json.Number`, strings for money; `*ProblemError` vs `*InvocationFailed`. |

Cross-language conformance (`test/sdk-conformance.test.ts`) runs the same scenario through the
TypeScript, Python and Go clients against a live Node host and compares canonical values.

Importing a vendor API: `forge import-openapi spec.json --package @vendor/name --out vendor/ --pin URL=FILE[@SHA256] --allow-host api.vendor.example`.
The importer never fetches; see `FOREIGN_IDS.md` and `import-report.json` in the output.
