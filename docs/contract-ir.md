# ForgeGraph contract IR

ForgeGraph keeps a registry of per-app API contracts in its own format,
contract IR v1 (`@forgegraph/contract/ir`). Apps publish one with
`fg contract publish --file contract.json`; ForgeGraph validates it with
`validateContract` and uses it for the Operations tab, SLO evaluation and the
API-contract gate. forgec writes, reads and compares that format.

```sh
forgec build examples/studio-desk --out dist --service-id service-desk   # dist/contract.json
fg contract publish --file dist/contract.json

forgec import-contract contract.json --package @acme/users --out users     # IR -> Forge package
forgec contract-diff old/contract.json new/contract.json --ignore policy.slo
```

## `forgec build` writes `contract.json`

`contract.json` sits next to `openapi.json` and is derived from it, the way
ForgeGraph's Effect generator derives a contract from `OpenApi.fromApi`. An
operation is in the contract exactly when it is in the OpenAPI document: every
`@crud` route, every `@http` function and the four workflow routes. Paths,
parameters, bodies and statuses are the same.

| contract field | source |
| --- | --- |
| `serviceId` | `--service-id`, else the last `/` segment of the package name (`@demo/service-desk` -> `service-desk`), invalid characters as `-`. ForgeGraph warns when it is not the app slug, so pass the slug when they differ. |
| `apiId` | the package name |
| `groupId` | the resource or workflow name (`Contact`, `EscalationFollowUp`); `functions` for functions. A non-root module, or a co-deployed dependency's package, is prefixed with `-`. |
| `endpointId` | the rest of the Forge operation id with `.` as `-` (`create`, `list-byOrganization`, `status-assign`, `start`), or the function name. Forge names never contain `-`, so ids cannot collide. |
| `transport` | `http`, the method, the OpenAPI path and the same path in Effect syntax (`/v1/tickets/:id`) |
| `request` | path, query and header parameters folded into one object schema each; JSON request bodies by content type |
| `successes` / `errors` | every declared status below / from 400, with its bodies |
| `components`, `securitySchemes` | `components.schemas` and `components.securitySchemes` of `openapi.json` |
| `policy.authentication` | the document's security requirement (`bearer`), classified as ForgeGraph classifies schemes: bearer -> `service` |
| `middleware` | one security row for the runtime's ingress authenticator, `@forgegraph/runtime/AuthHost` |
| `policy.isPublic` | `false`: nothing in a Forge package marks an operation public |
| `policy.sla` | empty: Forge declares objectives, not SLA policies |
| `policy.slo` | the operation's `x-forge-slo` (`[observability.slo.<class>]`, a function's `slo { ... }`, or the starter defaults), e.g. `{ "availability": 0.999, "latency": { "good": 0.99, "withinMs": 500 }, "windowDays": 28 }` |
| `generator` | `{ "name": "forgec", "version": <compiler version> }` |

Each `SchemaRef` carries the component name when the schema is a bare `$ref`
and a fingerprint over the schema plus every component it reaches.

### Fingerprints

ForgeGraph recomputes every fingerprint on ingest as
`sha256(JSON.stringify(sortKeys(value)))` and rejects a mismatch, so forgec
hashes the bytes V8 would produce, not `serde_json`'s: keys sorted by UTF-16
code unit with array-index keys enumerated first, numbers formatted by
`Number.prototype.toString` (`1`, `0.999`, `1e+21`, `1e-7`, integers beyond
2^53 rounded), strings escaped as `JSON.stringify` escapes them. Percentages
are shifted in decimal, so `99.9%` is the double `0.999` that ForgeGraph's
own fixture uses rather than `99.9 / 100`. Unit tests pin the serializer
against Node's output (`crates/forgegraph-codegen/src/contract_ir/canonical.rs`).

### Conformance

`conformance/test/contract-ir.test.ts` runs ForgeGraph's own
`validateContract`, vendored verbatim in `conformance/contract-ir/vendor`
(refresh with `conformance/contract-ir/vendor.sh <forgegraph-checkout>`), over
a curated set of contracts in `conformance/fixtures/contract-ir` (studio-desk,
console-playground, acme, foundation billing; `scripts/refresh-fixtures.sh`
writes them from the `contract_ir_fixtures` array) and over the hand-written
import fixture.

`scripts/validate-contracts.sh` builds every package in the repository (all
examples, `examples/next`, foundation packages and apps) into a temporary
directory and validates each contract the same way, committing nothing; CI
runs it in the runtime job. Locally: 103 packages, 1195 operations, 0
failures. To check any file:

```sh
pnpm --filter @forgegraph/conformance contract-ir "$PWD/dist/contract.json"   # paths resolve from conformance/
```

### Not in the contract yet

- View, projection, cache and schedule routes: the runtime serves them, but
  `openapi.json` does not describe them, and the contract is the same
  projection.
- Response headers (`ETag`) and parameter descriptions: the IR has no slot.

## `forgec import-contract`

Converts the contract to OpenAPI 3.1 (paths from `openApiPath` and the
method, parameters from the folded `params`/`query`/`headers` schemas, bodies
and responses by content type, components with `$ref`s rewritten when a name
is not a valid OpenAPI component key, security schemes and per-operation
security) and runs it through the OpenAPI importer, so both importers share
one mapping and one `import-report.json` (`version: "contract-import/1"`,
operations listed by contract id). The intermediate `openapi.json` is written
too.

A contract whose fingerprints do not match its content is refused. What Forge
cannot express is reported at its exact location, never approximated:

| feature | why |
| --- | --- |
| `rpc-transport` | RPC procedures have no HTTP binding; skipped |
| `http-method` | `@http` binds GET, POST, PUT, PATCH, DELETE; others skipped |
| `duplicate-route` | a second operation on the same method and path; skipped |
| `anonymous-operation`, `public-visibility`, `declared-authentication` | the runtime authenticates every request and has no visibility marker |
| `sla-policy`, `slo` | per-operation policy is not imported |
| `middleware` | non-security middleware has no equivalent |
| `alternate-media` | only the JSON body is imported |
| `additional-success-response` | a function has one output |
| `error-body`, `server-error-response`, `non-success-status` | Forge errors are Problem Details; 5xx are runtime failures |

Statuses the runtime serves on every function itself (401, 403, 412, 422) are
not turned into domain errors. Operations become functions named
`<Group><Endpoint>` (`users.getUser` -> `UsersGetUser`); operations in group
`functions` keep their endpoint name, and a name another declaration uses gets
an `Op` suffix.

## `forgec contract-diff`

Matches operations by method and OpenAPI path (parameter names erased; RPC by
procedure), so a renamed operation is one `id` difference. Schemas are
compared after inlining `$ref`s against each side's own components, ignoring
fingerprints, schema ids and titles, key order, the order of `required` and
`x-forge-enum` (an enum's declaration id; its values still count). Prints a
JSON report and exits 1 when any difference is not covered by `--ignore`
(a kind such as `id`, or a dotted prefix such as `policy`).

## Round trip

`build -> contract.json -> import-contract -> build -> contract-diff` is
tested on `examples/studio-desk`
(`crates/forgegraph-codegen/tests/contract_ir.rs`). Expected, because the
import produces `@http` functions rather than `@crud` resources:

- `id`: CRUD and workflow routes become functions (`Contact.create` ->
  `functions.ContactCreateOp`); a function keeps its id;
- `request.headers`, `request.query`, `request.bodies`: the function transport
  profile (`Idempotency-Key`, no `If-Match`, input as a JSON body);
- `successes`, `errors`: functions answer 200 and 401/403/409/412/422;
- `response.*`, `request.bodies` schemas: JSON Schema re-derived from Forge
  types (no `readOnly`/`default`, `x-forge-type` per scalar);
- `policy.slo`: the `function` objective class.

A regression is anything else: a route added or removed, a path, method,
authentication, visibility or middleware change. From the second generation
on the contract is a fixed point: importing and rebuilding it again changes
nothing.
