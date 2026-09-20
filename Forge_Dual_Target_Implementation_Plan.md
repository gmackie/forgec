# Forge: dual-target compiler and application runtime

**Design and implementation plan · 17 September 2026**  
**Status:** proposed architecture and acceptance criteria; not an implemented compiler or a deployed application.  
**Targets:** Cloudflare / Alchemy / D1 and AWS / CDK / DynamoDB.  
**Compiler:** Rust. **Application runtime:** TypeScript and Effect.

## 1. Product and engineering contract

Forge is an open-source language and toolchain for describing business-owned application data and capabilities. Business partners should recognize the resources, relationships, constraints, and operations. Engineers supply behavior that cannot be derived from those declarations. The toolchain generates the routine implementation rather than merely scaffolding files that must then be maintained by hand.

The application model has nine constructs:

| Construct | Meaning |
| --- | --- |
| `resource` | Authoritative structured records and their allowed operations. |
| `blob` | Opaque content with structured metadata and a managed upload/download lifecycle. |
| `cache` | Disposable values with an explicit loader and freshness contract. |
| `view` | A logical, read-only query over declared data. |
| `projection` | A persistent, rebuildable read model. |
| `function` | A typed executable capability, generated or implemented in normal code. |
| `workflow` | Durable composition of capabilities with explicit control flow. |
| `channel` | A typed messaging capability, optionally `send-only` or `recv-only`. |
| `source` | A one-way trigger such as a schedule or object notification. |

`type`, `shape`, and explicit named `enum` declarations make up the underlying type system. Decorators and blocks extend the nine constructs; they do not create another parallel application model.

**The product promise:** the same portable `.forge` package and the same application-owned Effect implementation files produce equivalent externally observable behavior on either supported deployment target. Operators use the same generated API, TypeScript client, and management workspace.

This is not a promise of equal latency, capacity, operating cost, infrastructure topology, or raw provider APIs. Those differ. It is a promise of the same defined application semantics within a declared operating envelope.

## 2. Decisions to lock before implementation

1. `.forge` is the canonical source. `forge.toml` describes a package or workspace; `forge.lock` pins dependencies and compiler-relevant versions.
2. Rust owns parsing, resolution, semantics, compatibility checks, and deterministic plans. Effect/TypeScript owns application execution, codecs, infrastructure integrations, and adapters.
3. Simple CRUD requires no handwritten implementation. Generated artifacts are not user-editable scaffolds.
4. Ordinary enums are named and explicit. A lifecycle synthesizes its named enum from its graph; authors never repeat a status field or state-member list.
5. `uses` declares resource capabilities and local or external callable dependencies. `sends` declares allowed message effects, not unconditional publication.
6. Imports provide contracts, not deployments, access grants, or permission to change an upstream system.
7. External bindings and semantic mappings must be supplied explicitly. Internal wiring is inferred only when ownership, identity, and transport requirements are known.
8. An independent relational/SQL IR supports D1 through Drizzle or Effect SQL. DynamoDB has its own planner and adapter; it is not disguised as a SQL target.
9. Every generated operation uses one mutation engine and one observability contract.
10. Both targets ship each portable feature together. “AWS later” is not an acceptable implementation strategy for a portable milestone.
11. Policy-language design is deferred. Authentication integration, tenant isolation, authorization hooks, and safe defaults are not deferred.
12. `source` stays one-way. HTTP request/response and WebSocket duplex communication are bindings on functions/channels, not a reason to redefine `source` again.

Package names beginning with `@forge/` and the APIs shown in this document are proposed project names, not claims that those npm packages currently exist.

## 3. What parity means, precisely

### 3.1 Shared contract outputs

The following generated artifacts should be identical for a given portable package, independent of target:

- Public request, response, event, and error schemas.
- Operation identities, route paths, methods, and exposed capabilities.
- The public TypeScript client and Effect service interfaces.
- Enum wire values, codec behavior, normalization, defaults, and validation messages/codes.
- UI metadata: field editability, relationship metadata, table/form descriptors, actions.
- Logical OTel operation identities, outcome classification, SLI definitions, and SLO definitions.

D1 migrations, DynamoDB key/index plans, Worker/Lambda entrypoints, bindings, IAM, and deployment resources necessarily differ. Endpoint origins, signed URLs, opaque cursors, generated IDs, and timestamps need not be byte-identical across independent deployments.

### 3.2 Shared behavioral guarantees

The portable contract specifies:

- Canonical input/output encoding, including absent versus null values.
- Tenant and authorization context handling.
- Concurrent mutation, idempotency, and retry behavior.
- Uniqueness and reference-integrity semantics.
- Soft deletion, restoration, hierarchy, and effective-date semantics.
- Query ordering, pagination, and read-consistency promises.
- Atomic versus resumable bulk changes.
- Publication acceptance, redelivery, subscription fan-out, and workflow completion semantics.
- Cache freshness and projection lag semantics.

For sequential tests with injected clocks and IDs, results can be compared exactly after removing deployment metadata. For concurrent tests, compare allowed histories and invariants rather than requiring the same request to win each race.

### 3.3 Portable profile and target-specific extensions

A portable build must validate against both target capability manifests before emitting deployable artifacts. Unsupported semantics cause a compile error with a source location and a suggested alternative. Never quietly turn a strongly consistent lookup into an eventually consistent one, an indexed query into a full scan, or an atomic changeset into partial writes.

A later opt-in target-specific profile may expose richer native behavior. Its generated artifact must clearly say that it is not dual-target portable. That is not the default.

### 3.4 Proposed initial operating envelope

These are Forge product defaults to validate and tune, not provider guarantees:

- Maximum normalized resource record: 64 KiB, including the public record; physical side-record sizes are checked separately.
- Maximum synchronous request/response body: 1 MiB; large imports and exports are jobs backed by blobs.
- Maximum inline channel payload: 64 KiB; larger values require explicit blob references and retention rules.
- List page default 50, maximum 100; nested relationship expansion is bounded.
- Bounded relational working set default 1,000 records. Larger computation requires an explicit projection/job or a reviewed plan.
- Atomic bulk changes: at most 10 logical mutations, further limited by the compiled physical action/byte budget. The preview endpoint reports the actual bound for that operation.
- No claim of snapshot consistency across ordinary list pages. An export requesting a stable snapshot uses a separate snapshot/job contract.
- Initial portability certification is for a single authoritative region/database group per deployment, not active-active multi-cloud writes.

DynamoDB currently limits an item to 400 KB and a transaction to 100 actions / 4 MB; Forge-generated index, integrity, audit, and idempotency items also consume transaction capacity. D1 has its own per-database, statement, binding, and execution limits. Account for the compiled plan, not merely the number of business records. [R03][R05][R06]

## 4. Source organization, modules, and contract identity

Recommended application structure:

```text
acme/
  forge.toml
  forge.lock
  src/
    index.forge
    shared/types.forge
    customers/customer.forge
    sites/site.forge
    sites/site-policy.forge
    orders/order.forge
    orders/order-events.forge
    orders/fulfillment.forge
    integration/payments.forge
  impl/
    submit-order.ts
    payment-adapter.ts
  deploy/
    cloudflare/alchemy.run.ts
    aws/app.ts
  migrations/
    contract/
    d1/
    dynamodb/
  generated/                    # Disposable artifacts; do not edit
  tests/
    contracts/
    scenarios/
```

A file can contain multiple declarations. Collect symbols before resolving references. No declaration has evaluation order or import-time side effects. Files in the package's default module share its symbol table; explicit modules can be added without equating runtime identity to a filename.

Moving a declaration between folders must not change its stable identity, rename a production table, or replace a deployed resource. Use package identity plus explicit module/symbol identity. A deliberate symbol rename is a reviewed compatibility/migration operation; a display-label edit is not a wire rename.

Suggested manifest:

```toml
[package]
name = "@acme/commerce"
version = "0.1.0"
edition = "2026"

[source]
root = "src"
entry = "src/index.forge"

[dependencies]
payments = { path = "../payments" }

[compatibility]
profile = "portable-v1"
targets = ["cloudflare-d1", "aws-dynamodb"]

[observability]
window = "28d"

[observability.slo.crud-read]
availability = "99.9%"
latency = { good = "99%", within = "500ms" }

[observability.slo.crud-write]
availability = "99.9%"
latency = { good = "99%", within = "1s" }
```

Those SLO numbers are starter targets, not measurements or SLAs.

Explicit exports form the public package surface. Cross-package imports resolve only exported declarations. Workspace/path dependencies are sufficient initially; add immutable archive/npm resolution with hashes next. A hosted package registry is not required.

Publish source, public semantic descriptors, source maps, and compatibility metadata. Do not publish secret values or environment bindings. Dependency IR must declare its format/compiler compatibility. Recompile source when supported rather than trusting arbitrary serialized executable plugins.

## 5. Language baseline

### 5.1 Type declarations and enums

```forge
enum CustomerTier {
  Standard = "standard"
  Gold = "gold"
  Enterprise = "enterprise"
}

type CustomerCode = text trim uppercase length 3..32

type OrderAmount = money<USD> >= 0

shape Address {
  line1 : text length 1..200
  line2 : text? length <= 200
  city : text length 1..100
  country : countryCode
}
```

Members default to their declaration name as a string wire value unless assigned explicitly. No implicit numeric ordinals. Reject duplicate wire values. Expressions use qualified members such as `CustomerTier.Gold`.

**Resolve reference versus record ambiguity:** when a resource name is used as a value type, `Customer` means its typed identity/reference. `Customer.Record` denotes the returned record shape. `Customer.Id` is an explicit alias for the identity type when helpful. A reference never causes an implicit database lookup. This removes the ambiguity in earlier sketches that used `Order` for both an ID and a fully hydrated result.

In TypeScript, references and semantic scalars are branded types with checked constructors. Brands prevent many accidental assignments; they do not make unsafe casts or arbitrary JavaScript impossible. Decode at every untrusted boundary.

### 5.2 Resources

```forge
resource Customer
  @tenant
  @timestamps
  @softDelete
  @versioned
  @audited
  @crud("/v1/customers")
{
  id : id
  code : CustomerCode @unique @immutable
  name : text length 1..200
  email : email?
  tier : CustomerTier = CustomerTier.Standard

  find by code
  list by tier
    order by name asc
}

resource Site
  @tenant
  @timestamps
  @versioned
  @audited
  @crud("/v1/sites")
{
  id : id
  customer : Customer @immutable
  code : text trim uppercase length 2..24 @immutable
  name : text length 1..200
  timezone : timezone
  enabled : boolean = true

  unique code within customer
  find by customer, code
  list by customer
    order by name asc
}
```

`@crud` is binding sugar, not a tenth construct. It expands into generated function HTTP bindings. An optional `operations` allowlist narrows exposure; lifecycle/custom actions are not implicitly published by a CRUD binding. Expose those actions explicitly so a generated route cannot bypass a custom business function. Without explicit exposure, declarations remain unexposed. Production builds require an authentication/authorization host binding; development-only anonymous access must be explicit.

`@tenant` adds server-owned scope to keys, unique claims, references, queries, metadata, cursors, and messaging context. In the reference app, Acme is the authenticated organization. `Customer` records are Acme's customers, not interchangeable with the tenant identity.

### 5.3 Lifecycle

```forge
resource Order
  @tenant
  @timestamps
  @versioned
  @audited
{
  id : id
  customer : Customer @immutable
  site : Site
  subtotal : OrderAmount
  tax : OrderAmount
  total := subtotal + tax
  requestedOn : date
  notes : text? length <= 2000

  rules {
    site.customer == customer
  }

  lifecycle status {
    initial Draft
    terminal Completed
    terminal Cancelled

    submit: Draft -> Submitted
    approve: Submitted -> Approved
    complete: Approved -> Completed

    cancel: Draft | Submitted | Approved -> Cancelled
      input {
        reason : text length 1..500
      }
  }

  list by customer
    order by createdAt desc
  list by site, status
    order by createdAt desc
}
```

The state set is inferred from the graph; `Order.Status` is generated. Require an explicit `initial` assertion in the first implementation so adding an incoming edge cannot silently change creation defaults. This does not repeat the enum. Terminal assertions prohibit outbound transitions. Diagnose unreachable states, duplicate action names, ambiguous/incompatible transition input, and suspicious misspellings. Inferred state names cannot prove that the author intended every spelling.

Lifecycle fields are omitted from generic create/update inputs. Creation uses the declared initial state. Transitions use generated commands with expected-version checks. A bare graph transition is fully generated; domain effects beyond it require a bound implementation.

### 5.4 Functions, HTTP, and uses

```forge
shape SubmitOrderInput {
  order : Order
  expectedVersion : integer >= 1
}

function SubmitOrder
  @http(POST, "/v1/orders/{order}/submit")
{
  input SubmitOrderInput
  output Order.Record

  uses {
    Order read
    Order.status.submit
    Site read
    payments.AuthorizePayment
  }

  sends {
    OrderSubmitted to OrderEvents
  }

  errors {
    SiteDisabled
    PaymentDeclined
    PaymentUnavailable
  }

  slo {
    availability 99.9% over 28d
    latency 99% <= 1s over 28d
  }
}
```

The function's body lives in `impl/`; the generated TypeScript interface exposes exactly the declared dependencies. Operation-specific `uses` and grouped resource capabilities are both allowed. Missing implementations or external bindings fail a production build. `sends` is permission to stage publication, not a claim that publication happens on every path.

HTTP path fields are bound explicitly by name. The API compiler defines body/query/path mappings; it rejects collisions or unspecified required inputs rather than guessing. The application receives a normalized input and trusted invocation context, not a raw Worker or Lambda event.

### 5.5 Channel and source rules

```forge
channel OrderEvents {
  distribution broadcast
  delivery at-least-once

  message OrderSubmitted {
    order : Order
    customer : Customer
    revision : integer >= 1
  }
}

channel PaymentEvents from payments.PaymentEvents {
  recv-only
}

on OrderEvents.OrderSubmitted -> FulfillOrder

source NightlyReconciliation {
  cron "0 3 * * *"
  timezone "UTC"
  -> RebuildOrderSummary
}
```

`send-only` and `recv-only` are local capability restrictions. An unrestricted channel supports both roles where the deployment provides them. Imported contract identity is distinct from local binding identity. Subscriptions are edges, not additional top-level resource kinds.

**Distribution is independent of direction.** `broadcast` means one durable delivery per logical subscription; `work` means one competing worker group handles each delivery. Do not infer broadcast from a queue name.

Source adapters normalize scheduled events, object notifications, and other one-way triggers. Request/response HTTP is a function binding. A WebSocket uses duplex channel binding metadata with distinct inbound/outbound message types and connect/disconnect contracts.

## 6. Semantic types, codecs, and constraints

A field carries a semantic type, canonical representation, approved boundary codecs, ordered normalizers, refinements, and documentation. Compile these into `CodecIR` and `ConstraintIR`, not arbitrary callback strings.

The common write pipeline is:

```text
Boundary framing/size checks
  -> strict decode for this boundary
  -> declared source conversion
  -> deterministic normalization
  -> field validation
  -> candidate-record construction
  -> record/relationship validation
  -> guarded commit
```

Use strict canonical JSON for APIs. CSV/XLSX import profiles may accept extra textual representations, units, and locales. Do not make every API silently coerce the import wizard's permissive input language.

Specify the following before implementing code generation:

| Concern | Proposed portable rule |
| --- | --- |
| `T?` | May be absent/null on create; canonical read exposes null when unset. PATCH omission means unchanged; null explicitly clears an optional field. |
| Defaults | Apply on creation when omitted; never overwrite an explicit null or reapply during PATCH. |
| Integer | Safe, finite, exact integer range supported by both TS adapters; reject overflow. |
| Decimal/money | Exact fixed-point semantics. API decimal strings; runtime scaled integer/decimal implementation. No binary floating-point money. |
| Initial money storage | Bounded minor units within the D1/JS exact integer range; Dynamo stores the same minor-unit semantics. Wider precision requires a separately implemented plan. |
| Currency/unit | Explicit semantic metadata; no silent FX conversion or unspecified unit assumptions. |
| Time | `date` is a calendar date, `datetime` an instant in normalized UTC at declared precision, `localTime` a wall-clock value. |
| Duration | Fixed elapsed-time units; months/calendar recurrence are not silently converted to seconds. |
| Text order | A documented binary/canonical sort key, not environment-dependent locale collation. |
| Normalization | Explicit, versioned, and ordered. Do not indiscriminately lowercase an email local part or merge business names. |
| Unknown fields | Reject writes to undeclared/server-owned fields rather than silently accepting mass assignment. |
| Conversion ambiguity | A structured error/proposal, never a guess. |

D1 and Dynamo key ordering must agree with Forge comparison semantics. Define a versioned, delimiter-safe identity codec and a separate order-preserving sort codec. Numeric sort keys must not sort `10` before `2`; composite field encodings must not collide. Add fuzz and property tests for both.

Runtime constraints have scopes: field, row, related record, set, and temporal/hierarchy. The compiler reports where each is enforced. UI validation is advisory; the server is authoritative. SQL constraints add defense in depth when available. Dynamo item schemas do not replace application validation.

Cross-resource checks require race-safe enforcement at commit. A read of `site.customer` before a write is insufficient when Site can change concurrently. Imported references provide type identity, not a distributed foreign key; their external resolver has an explicitly weaker or separately warranted consistency contract.

Rust constant evaluation and TypeScript runtime semantics must share golden vectors. Restrict regular expressions to a documented interoperable subset; avoid Rust/JS regex feature drift. A browser/WASM semantic kernel is an option later, not a second independently specified type system.

## 7. Compiler pipeline and intermediate representations

```text
forge.toml + forge.lock + .forge sources
        |
        v
Lossless syntax tree -> typed AST -> package/symbol graph
        |
        v
DomainIR + CodecIR + ConstraintIR
        |
        +-> OperationIR / MutationIR / QueryIR
        +-> ExecutionIR / MessagingIR
        +-> ObservabilityIR
        |
        +-> RelationalIR -> SQL schema/access/migration IR
        |                     -> SQLite/D1 dialect plan
        |                     -> Effect SQL or Drizzle adapter artifacts
        |
        +-> DynamoIR -> entities, access items, integrity guards,
        |              transactions, backfills, serialization
        |
        +-> HTTP/OpenAPI, client, UI, AsyncAPI/Smithy projections
        |
        +-> CloudflarePlan -> Alchemy composition
        +-> AwsPlan        -> CDK construct tree
```

### 7.1 Rust implementation

Start with a Logos lexer, hand-written recovery-oriented recursive-descent parser, and Pratt expression parser. A lossless Rowan tree supports formatting, incremental tooling, comments, source spans, and structural edits. Serde is suitable for versioned IR serialization. These are implementation choices, not claims that Rust itself makes compilation incremental. [R25][R26][R27]

Keep the initial compiler in a small number of crates: syntax, semantic/IR, planners, emitters, CLI. Split further when boundaries stabilize. A dozen empty micro-crates is not useful progress.

Native CLI is the first integration boundary. The npm build adapter can invoke the CLI using JSON stdin/stdout. Add Node native bindings and browser WASM after semantics and diagnostics are stable. Keep compiler-core filesystem/network-free; source loading and dependency resolution are host services.

### 7.2 Determinism

Build identity includes source content, dependency content hashes, compiler version, standard-library/codec versions, target capability-manifest versions, build options, and the previous schema baseline for migration generation.

Sort maps and emitted declarations deterministically. Exclude wall-clock timestamps, absolute machine paths, random identifiers, and live account discovery from pure compilation. A build plan can have unresolved external binding slots; deployment resolves actual provider IDs.

Migrations are deterministic from old model + new model + explicit rename/backfill decisions, not from the new source alone. Runtime record IDs are separate from deterministic infrastructure identities.

### 7.3 Required semantic checks

Resolve symbols and exported visibility; check nominal references; validate enum defaults; elaborate decorators; reject field collisions and decorator conflicts; type-check expressions, lifecycle graph, function dependencies, message directions, and workflow edges; classify constraints by enforcement requirements; derive operation capabilities; validate both physical plans and budgets; identify missing implementations/bindings; emit source-linked diagnostics.

A deploy build must have no “TODO implementation” paths. A check-only contract package may contain intentionally external callables, marked as such in package metadata.

## 8. Shared runtime: Effect services, not provider SDKs

The shared runtime owns decoding, authorization context, validation, domain errors, mutation planning, audit records, idempotency policy, event envelopes, telemetry classification, and high-level operation contracts.

Provider adapters execute typed plans and expose capabilities. They must not independently decide field mutability, default values, errors, or whether a failed version check should be ignored.

Proposed public service shape:

```ts
// Interface sketch: generated by Forge; not a currently shipped API.
interface SiteReader {
  readonly get: (
    id: SiteId,
  ) => Effect.Effect<SiteRecord, NotFound | StorageUnavailable>;

  readonly listByCustomer: (
    input: SiteByCustomerInput,
  ) => Effect.Effect<Page<SiteRecord>, InvalidCursor | StorageUnavailable>;
}

interface SiteWriter {
  readonly update: (
    command: UpdateSiteCommand,
  ) => Effect.Effect<SiteRecord, UpdateSiteError>;
}
```

Application implementations receive declared services via Effect requirements and Layers. Workers construct runtime Layers from bindings; Lambda constructs them from environment configuration, AWS clients, and its execution role. Process-level clients may be reused; tenant/request context must be isolated per invocation. Pin one tested Effect major/version set across generated code and adapters. Effect's current documentation explicitly provides typed successes/errors/requirements, services, concurrency, tracing, and schema decoding. [R10]

Do not expose `D1Database`, `DynamoDBClient`, Lambda context, or raw Worker bindings in portable business implementations. Raw escape hatches can exist but invalidate portability/capability claims for that implementation.

A capability interface is not a security sandbox. Actual isolation also depends on IAM/binding scope and deployment partitioning. Group functions by trust boundary and required bindings, not automatically one Worker/Lambda per logical function.

## 9. One mutation model for every interface

A `ChangeSet` is the central internal model, without becoming a tenth public topology noun. A form save, spreadsheet paste, CSV import, agent command, generated transition, or custom function can propose the same normalized operations.

A mutation contains tenant and actor from trusted context, operation ID, resource identity, expected revision, normalized input, schema hash, request hash, and optional idempotency key. The preview can contain multiple operations and stable human-readable diffs.

Pipeline:

1. Authenticate; establish tenant and operation authorization.
2. Decode and normalize input; reject server-owned fields.
3. Load required state and build the candidate change.
4. Validate fields, row invariants, and relationships.
5. Build a typed guarded mutation plan.
6. Commit record changes, integrity metadata, audit, idempotency receipt, and outbox entries atomically within the supported boundary.
7. Return the canonical result and new revision; asynchronously deliver committed outbox work.

Preview is not a lock. Recheck permissions, approved content hash, revisions, and state-dependent predicates at commit. An approval binds the exact changeset, not a draft that can be altered afterward.

Automatic retries are limited to declared retryable operational conflicts. A stale user revision is not silently retried against new state. Logical request idempotency is separate from a provider's short retry token.

## 10. D1 implementation plan

### 10.1 Physical schema

One D1 database per application database group for the reference deployment. Resource tables include tenant scope, logical ID, revision, timestamps, soft-delete marker where declared, and normalized physical fields. Composite tenant/resource foreign keys prevent cross-tenant references.

System tables hold audit, idempotency receipts, outbox, subscription delivery status, imports, changesets, projection generations/checkpoints, and contract/migration metadata. Create only the system facilities required by the enabled features.

Strong portable reads go to the primary. Replica use is an explicitly selected weaker/causal read profile with bookmarks, not a silent optimization. D1 Sessions provide sequential consistency and a `first-primary` option; ordinary bindings without Sessions currently query the primary. [R04]

### 10.2 SQL IR and runtime choice

`SqlSchemaIR`, `SqlAccessIR`, and `SqlMigrationIR` are separate. Forge owns physical semantics, constraints, stable naming, cursor expressions, and migrations. Drizzle generates a familiar schema/query facade; Effect SQL provides direct Effect-native execution. Both must execute the same logical plans and pass the same conformance tests.

Do not assume an ORM transaction callback is supported by every D1 driver. The atomic primitive here is a tested D1 batch of SQL statements, not an arbitrary JavaScript callback containing reads and writes. D1 documents transaction-style rollback for a failed statement in `batch()`. [R04]

### 10.3 Guarded mutations: an early correctness spike

A conditional UPDATE affecting zero rows is not an SQL error. Therefore `UPDATE ... WHERE version = ?; INSERT audit; INSERT outbox` is not automatically safe.

Implement a checked SQL lowering in which a failed precondition actually aborts the batch, or makes every subsequent effect conditional on the same successful mutation with a proven outcome. One candidate is an internal assertion table with a CHECK constraint: insert a per-command assertion based on an SQL predicate, perform the guarded update and associated writes, then remove the assertion within the same batch. Failed CHECK rolls back the batch. This design must be validated against live D1 before the adapter is certified.

Batch SQL predicates must evaluate the expected revision and relevant reference/temporal conditions inside the batch. Do not depend on an earlier application-side read remaining true. Do not use `exec()` with interpolated values. Translate provider errors through stable operation outcomes, avoiding fragile parsing of raw error messages as the sole correctness mechanism.

### 10.4 Limits and indexes

Generate bound, allowlisted SQL. Size each statement against actual bound parameters and columns, not a hardcoded “250 rows per batch.” D1 currently permits 100 bound parameters per query and 100 columns per table; adding generated columns can consume that budget. Its database size and execution limits also constrain the operating envelope. [R05]

Generated index declarations are plans, not promises the SQL optimizer will always select them. Snapshot EXPLAIN output for representative queries and benchmark adversarial distributions. Avoid redundant prefix indexes unless a measured reason justifies them.

## 11. DynamoDB implementation plan

### 11.1 Do not treat DynamoDB as schemaless JSON storage

Use a compiled key/access model. For the initial application, one data table per application database group is reasonable, with isolated system data where scaling, permissions, or retention require it. Table allocation remains a deployment decision, not a resource keyword.

Conceptual physical items:

```text
Entity:     tenant + resource + id
Unique:     tenant + resource + unique-key-name + canonical-key-values
Access:     tenant + resource + query-name + equality-values / ordered-key + id
Integrity:  tenant + resource-id + relation/temporal/tree guard
Audit:      tenant + operation-id
Receipt:    tenant + idempotency-scope + idempotency-key
Outbox:     tenant + operation-id + event-ordinal
```

These are explanatory shapes, not a literal delimiter-unsafe key format. The key codec and partitioning plan are versioned.

### 11.2 Strong portable queries need explicit access items

DynamoDB's GSIs are eventually consistent; they cannot satisfy a portable immediate-read guarantee merely by setting a flag. [R07]

For the portable strong-read profile, generate base-table access items and maintain them in the same transaction as their authoritative record. An access item contains the row's declared public query projection, ID, and revision; reading it strongly avoids a second uncoordinated hydration read. A query uses a known partition plus sort/range conditions.

This costs write amplification, storage, and transaction actions. Explain that cost in `forge explain`; bound the number and size of generated access paths. Broad low-cardinality partitions require deliberate sharding and cursor merging at scale, not blind insertion of a GSI per query.

For explicitly eventually consistent read models, GSIs may be a valid optimization. Never use them for uniqueness, referential-integrity decisions, or strong-read queries. A filter expression runs after Dynamo reads data, so it does not make an unbounded query efficient. [R08]

Strong item reads do not create snapshot semantics across a multi-page query. Both targets expose the same documented no-snapshot pagination contract.

### 11.3 Unique constraints

Allocate a unique-claim item per canonical constrained value, in the same transaction as the entity. Changing a key moves the claim atomically; deletion/restoration follows the declared uniqueness policy. AWS documents this transaction-plus-claim pattern for enforcing additional unique attributes. [R09]

Default policy: a soft-deleted record retains its unique keys until explicit purge. This avoids surprising restore conflicts. An active-only uniqueness policy can be added explicitly, with restore conflict behavior tested on both backends. Optional null values do not reserve a claim unless the contract requests that behavior.

### 11.4 Referential integrity and deletion

Foreign keys require a generated protocol, not an existence check followed by an unrelated put. Maintain guarded parent/reference metadata so creating a child and deleting/archiving its parent cannot race into an orphan. Reference creation checks active tenant-scoped parent identity and increments/co-updates integrity metadata atomically. Restrict-delete checks the same guard and zero live dependents.

Coalesce multiple actions on the same physical item: DynamoDB cannot update and separately ConditionCheck the same item in one transaction. These guards can introduce hot keys; the planner must report contention risk rather than claim unlimited relational scale. [R03]

Privileged writes bypassing Forge can violate these invariants. Generated resources are owned by the Forge mutation path; provide an explicit maintenance/reconciliation mode for administrative repair.

### 11.5 Transactions, retries, and derived metadata

Compile `MutationIR` to conditional puts/updates/deletes in `TransactWriteItems`. Include audit, outbox, idempotency receipts, unique claims, access entries, and integrity guards in the physical budget. Use native client tokens for immediate retry protection and persistent Forge receipts for the declared longer logical idempotency window. The native Dynamo transaction token window is currently 10 minutes. [R03]

Use BatchWrite only for explicitly safe staging/rebuild cases with no concurrent mutation semantics. It is not the implementation for versioned interactive bulk edits.

A schema/index change may require rewriting key encodings, backfilling access items, building projections, or changing readers. “No table DDL change” never means “no migration.”

## 12. Generated API and concurrency contract

Expose generated operations only through explicit bindings. One public schema/client is reused against either base URL.

| Operation | HTTP surface |
| --- | --- |
| Create | `POST /v1/customers` |
| List | `GET /v1/customers` |
| Read | `GET /v1/customers/{id}` |
| Update | `PATCH /v1/customers/{id}` |
| Soft delete | `DELETE /v1/customers/{id}` |
| Restore | `POST /v1/customers/{id}/restore` |
| Named query | `GET /v1/customers/queries/by-tier?tier=gold` |
| Lifecycle | `POST /v1/orders/{id}/actions/approve` |
| Bulk proposal | `POST /v1/changesets` |
| Bulk preview | `GET /v1/changesets/{id}/preview` |
| Commit | `POST /v1/changesets/{id}/commit` |
| Async status | `GET /v1/jobs/{id}` |

Static query routes are resolved before record placeholders. Operation IDs are stable symbols, not derived from mutable display labels.

Reads return a revision and strong ETag. Updates/deletes/transitions require `If-Match` for HTTP or `expectedVersion` for direct SDK commands. Missing required HTTP precondition returns 428. Failed `If-Match` returns 412, not the 409 used in some earlier sketches. Use 409 for uniqueness/business-state conflicts, 422 for semantic input violations, 400 for malformed encoding, and 503 for unavailable infrastructure. Follow Problem Details with stable Forge extensions for field paths, constraint IDs, retryability, and request IDs. [R28][R29][R30]

Reject body/header precondition contradictions. The same semantic `VersionConflict` can map to 412 at HTTP and remain a typed error in a direct Effect call.

An idempotency key is scoped to tenant + operation + stable request hash. Reusing it with a different request is a conflict. A persisted receipt returns the previous logical result after an uncertain response, without repeating effects. Generate clocks/IDs through injected services and preserve generated values within a retried logical command.

Cursors are opaque and integrity-protected; include query ID, contract version, tenant/context fingerprint, sort key, tie-breaker ID, and optional consistency metadata. Do not expose raw Dynamo LastEvaluatedKey or D1 bookmarks as the cross-provider API contract. Changing deployment need not preserve outstanding cursors; return an explicit invalid/expired-cursor error.

## 13. Blobs and imports

Blob content resides in R2 or S3; metadata resides in D1 or DynamoDB. The portable API returns an upload session and provider-specific upload authorization. S3 and R2 support direct presigned uploads; these are temporary bearer capabilities, not evidence that uploaded bytes satisfy the contract. [R16][R17]

Lifecycle:

```text
intent -> uploading -> uploaded -> verifying -> ready
                               \-> rejected
```

Use server-assigned staging keys. Verify actual object size, type/content policy, checksum, and origin binding. A presigned URL may still be valid after an initial upload. Finalization must bind to immutable bytes: seal/copy to a private immutable generation, or use a verified provider version/precondition mechanism. Publish only the sealed object identity; never keep reading whatever a still-writable staging key contains.

The portable ObjectRef contains logical blob identity, content digest, byte count, media type, and sealed generation metadata. Provider-specific location details remain private. Do not assume ETag is a universal content hash. Object notifications can be duplicated or delayed; they reconcile upload state rather than authorize it.

Imports use the same mutation engine:

```text
R2/S3 -> inspection -> mapping profile -> streamed parsing
      -> normalization -> validation -> staged ChangeSet
      -> preview -> guarded commit -> report
```

Start with CSV, including quoted multiline cells, BOM/encoding policy, CRLF, and bounded field/row counts. Split large input only at parser-confirmed record boundaries; arbitrary byte/newline splitting is incorrect for quoted CSV. Store parser checkpoints or normalized bounded chunks in object storage. Add XLSX after a streaming/decompression/resource-budget spike; never load arbitrary workbooks into memory or execute formulas/macros.

Whole-file uniqueness and cross-row validation require a staging index or bounded sort/join strategy. Errors are chunked artifacts with an index; a single large JSONL object is not magically cheaply pageable. A UI can correct staged cells and regenerate the diff without altering live records.

Default bulk behavior is resumable per-record commits with per-row results and idempotency. Atomic mode is available only within the physical budget. Large atomic configuration replacement uses a separately defined immutable-revision publication model, not a false transaction guarantee.

Original files are provenance for imported input, not the sole source of truth once users edit through APIs/forms. Reprocessing creates a new proposal and preserves subsequent edits unless explicitly overwritten through the same conflict checks.

## 14. Messaging and internal wiring

Every internal state-changing operation that needs downstream effects stages an outbox record in the database transaction. Queue publication cannot be atomically committed with a database write, so publishing directly after a successful write is not the correctness model.

The outbox dispatcher supports persisted delivery status, bounded leases/retries, poison-message handling, and reconciliation. On Cloudflare, combine prompt post-commit nudges with a durable outbox scan; `waitUntil` alone is not a delivery guarantee. On AWS, Dynamo Streams can accelerate dispatch but a sweep of undelivered outbox state remains the recovery path.

Consumers record a processed message ID in the same local mutation transaction where possible. An external side effect requires the downstream provider's idempotency capability or an explicit workflow/compensation strategy. A message ID decorator alone cannot make arbitrary code exactly-once.

### Broadcast fan-out

A broadcast channel expands into one durable delivery per logical subscription. Cloudflare Queues currently allow one active consumer per queue, so the planner must produce per-subscription queues and a dispatcher, or another explicit fan-out implementation. It cannot simply bind several independent consumers to one queue. AWS can use SNS/EventBridge plus one SQS queue per subscription, or an equivalent outbox fan-out plan. [R11]

Record delivery status per subscription so one failed consumer does not cause already-completed consumers to repeat uncontrolled side effects. Freeze the target subscription set for a publication or explicitly define how newly added subscriptions receive history.

Cloudflare Queues and Lambda/SQS consumption allow duplicate deliveries. Portable baseline: at-least-once handling attempts, no guaranteed ordering, explicit retention and retry limits, independent consumer deduplication. [R12][R13]

Ordering/replay requirements are separate opt-in capabilities. Per-subject ordering needs a generated coordinator/sequence protocol on Cloudflare or another proven realization. FIFO branding on one provider is not proof of cross-provider exactly-once processing.

### External integrations

External slots specify direction, message contract, codec, mapping, authentication reference, idempotency behavior, and delivery guarantees. Implementations map external identifiers to logical resources explicitly. A shared upstream Forge package can remove schema duplication; it does not prove that equal-looking IDs refer to the same identity domain.

SNS receive bindings require subscription delivery; they are not invented topic polling APIs. Webhook bindings verify signatures against raw bytes before decoding. External message metadata never supplies trusted tenant identity without authenticated mapping.

## 15. Workflow parity

Use one typed `WorkflowIR`: named steps, calls, bindings between inputs/outputs, conditionals, bounded parallel branches, waits, sleeps, terminal results, and typed error branches. Stable step IDs are semantic identifiers, not line numbers.

Cloudflare lowers to WorkflowEntrypoint and durable step APIs. AWS lowers to Step Functions Standard plus Lambda activities or verified service integrations. Standard supports callback waits; Express is not the baseline for this feature because its integration patterns differ. [R14][R15]

Run the same business implementation for each activity. Do not call raw Dynamo integrations on AWS when doing so would bypass Forge validation/audit/outbox rules that run on Cloudflare.

Implement a common durable signal inbox keyed by tenant, workflow instance, wait step, correlation key, message ID, and execution version. Persist a signal before acknowledging its source. Events may precede waiter registration; a signal inbox closes that race on both targets. Cloudflare can buffer events after an instance exists, but the portable bridge also covers pre-registration and provider-neutral deduplication. [R14]

Only deliver authenticated, correctly correlated signals. Keep AWS callback tokens private and scoped. Define expiry, duplicate policy, timeout races, cancellation, and late-signal behavior. An authorized signal racing a timeout yields one terminal outcome, not both.

Activity idempotency keys derive from workflow instance + pinned workflow version + logical step + logical operation, not retry attempt number. Distinguish retry count from application completion. Pin in-flight workflows to compatible implementations; deployment does not silently reinterpret their step graph.

Do not launch irreversible payment capture in parallel with a fraud check that can reject it. Use authorization then capture, or an explicitly compensatable flow. A saga is not an ACID transaction, and compensation can also fail. Add compensation after sequence/wait/retry semantics pass fault-injection tests.

Large inputs/outputs are immutable blob references. No unbounded fan-out or arbitrary runtime code generation in the workflow DSL.

## 16. Cache semantics

Cache correctness must be specified independently of the store.

Portable baseline: cache-aside, reconstructible loader, explicit `freshUntil`, optional `staleUntil`, source revision, contract hash, and trusted tenant scope. The runtime rejects expired entries on read; physical TTL is cleanup only. DynamoDB TTL deletions are asynchronous and can occur days after expiry. [R19]

KV does not provide a hard global freshness bound merely because a TTL is present; its distributed caches and eventual consistency require a version/freshness check. A hard freshness contract may choose authoritative revision reads, a coordinator, or bypass the cache. [R18]

A loader of effective-dated configuration has `freshUntil = min(policy TTL, next effective boundary)`. A cache key must include every input affecting the result. Do not accept arbitrary `at` values while keying only by Site. A “current policy” cache has a separate reader contract from an arbitrary-time resolver.

Start with local-process single-flight on both targets. Do not claim this deduplicates work globally across Worker isolates or Lambda instances. Distributed single-flight is a separate coordinator capability with leases/fencing and failure semantics.

Default failure behavior is to fall back to the authoritative loader, or return a declared error. Stale fallback is explicit and bounded. Lost cache contents never lose business truth.

For an economical first cloud implementation, a separate disposable D1 cache table / DynamoDB cache item family is acceptable. KV, Workers Cache API, Redis-compatible services, or DO-backed variants are optimization adapters that must pass the same freshness tests.

## 17. Views and projections

Views use a restricted typed query algebra: source, equality/range predicates, declared ordering, projection, and bounded relationship expansion. D1 lowers compatible expressions to SQL. Dynamo uses named access plans and bounded joins/hydration, never a silent unlimited scan.

Not every SQL query has an efficient Dynamo equivalent. When a view needs unbounded grouping or joins, require a materialized projection or reject the portable plan. Do not turn a synchronous authoritative view into an eventually updated table without a contract change.

Projection support should start with group-by, count, exact fixed-point sum, and deterministic filters. Maintain per-source entity revision/contribution and deduplicate changes. Stale/out-of-order events do not overwrite a newer contribution. Min/max and non-invertible aggregates need auxiliary candidates or group recomputation rather than incorrect subtraction.

Expose generation, progress, last processed position, and freshness. Reads can report “not ready” or wait for a declared revision instead of silently returning an empty successful result.

Rebuild into a new generation and switch the active pointer after validation. The first rebuild implementation may require an explicit quiescent window for its authoritative input, applied identically on both targets. A later online rebuild requires a consistent snapshot plus retained change-log catch-up; “scan and then flip” while writes continue is not a proven rebuild protocol.

Search/vector backends are optional projection targets later. They do not expand the guaranteed portable query language for free.

## 18. Effective dating and hierarchy

### Effective dating

`@effectiveDated(uniqueBy: [site])` synthesizes required start and optional end instants. Intervals are half-open `[from, until)`; `from < until` when an end exists. Null end means unbounded future. An adjacent interval beginning at the previous end does not overlap.

Separate effective time from record revision/audit time. Do not conflate this with full bitemporal storage.

For D1, enforce overlap checking within the guarded batch. For Dynamo, query interval neighbors under a per-group revision guard and conditionally advance that guard when writing. Every mutation in the group participates; a plain query-before-put has a race. Bound interval queries and retry contention predictably.

`effective(site, at)` returns zero-or-one by contract. Missing policy is a typed result/error, not an arbitrary default. Time-zone/day-oriented authoring is normalized with explicit zone and DST policy.

### Hierarchy

`@hierarchical` adds an optional same-resource parent and generated parent/children/ancestor traversal plus `move`. IDs do not contain materialized parent paths, so moving a node never changes its business identity.

A move validates same tenant, parent existence, no self-parent/cycle, and configured depth/size limits. Concurrent moves require a tree/scope guard or equivalent protocol. Updating A under B and B under A must not both commit.

D1 can use adjacency queries and database-transaction guards. Dynamo can use adjacency access items plus a scoped revision guard. Traversals are paginated/bounded; large subtree moves/exports are jobs. Default deletion is restricted while live children remain. Cascading business behavior requires an explicit action.

These features are generated semantics only once their concurrency protocols pass certification, not decorative columns added in the first parser milestone.

## 19. Scheduling and realtime

Schedules are parsed into a canonical recurrence IR; do not forward a cron string unchanged to both providers. Define weekday numbering, day-of-month/day-of-week combination semantics, timezone, overlap, skipped times, repeated times, and missed-run catch-up.

Cloudflare Cron Triggers use UTC, whereas EventBridge Scheduler supports timezone-aware schedules. For local-time schedules, generate a shared recurrence calculation and occurrence ledger, with Cloudflare ticks/coordinator alarms and AWS schedules that match those rules. The simplest portable first release supports UTC schedules; local-time support ships when both adapters agree across DST fixtures. [R20][R21]

Occurrence idempotency uses schedule identity + intended occurrence instant, not the observed delivery time. Define overlap as allow, skip, or serialize. Retries of the same occurrence do not create a second logical run.

WebSocket portability is a separate profile: text JSON messages, capped frame size, authenticated session routing, reconnect/resubscribe, logical sequence numbers, and explicit delivery policy. Cloudflare can use Durable Objects; AWS can use API Gateway WebSocket APIs plus a connection registry and routing functions. Connection IDs/URLs differ; the logical message contract is shared. Do not promise preserved connection identity or exactly-once delivery through disconnects.

## 20. Observability and SLO compilation

Every generated CRUD operation is a generated function with the same telemetry wrapper as handwritten functions. Emit provider-independent logical operation IDs and provider-specific child spans only at adapter boundaries.

`ObservabilityIR` includes span plans, bounded metric dimensions, SLI event classification, histogram boundaries, logical-versus-attempt counting, freshness/lag indicators, and SLO definitions.

Use standard HTTP and messaging semantic conventions rather than inventing a parallel protocol vocabulary. Add only the domain dimensions Forge supplies. Propagate trusted trace context; use links for batches, fan-in, and long-lived workflow correlation where a single parent chain is inappropriate. [R23][R24]

Example starter defaults: CRUD reads 99.9% successful eligible requests with 99% within 500 ms; writes 99.9% and 99% within 1 s; rolling 28 days. These are editable targets, not predicted performance. Generated histograms include exact SLO threshold buckets.

Error categories need explicit policy. Correctly rejecting malformed input may be excluded from an availability denominator; failing a valid accepted request because a dependency is unavailable is not “good” merely because its error type was declared. Keep business outcome metrics separate from service reliability. Count timeouts, exhausted retries, admission failures at their defined measurement boundary, and workflows that miss a deadline—not only operations that eventually complete.

Do not calculate exact SLO counts from sampled traces. Emit unsampled counters/histograms or a dedicated complete-enough event pipeline, and track export gaps. Unsampled instrumentation is not a proof that telemetry cannot be lost when a process dies.

Cloudflare's built-in OTLP export currently supports traces/logs but not Worker/custom metrics. Plan a separate tested metrics export path or event-to-metrics collector; do not assume native parity. AWS and Cloudflare can feed the same OTel collector/backend contract. [R22]

Sensitive values, record IDs, email addresses, and unbounded tenant IDs are not default metric labels. Mask/redact trace attributes according to field metadata and policy. Database query text must not embed private input. Deployment tags may differ; logical SLO identity remains stable.

Compile vendor-neutral SLO descriptors plus one tested backend emitter first. Broad dashboard integrations can follow. Alchemy/CDK provision required collector bindings/resources where appropriate; Forge does not build a telemetry database.

## 21. Infrastructure integration

### Cloudflare / Alchemy

`@forge/alchemy-cloudflare` consumes the compiled plan and expands into ordinary Alchemy resources. Do not hide the entire application inside an opaque custom resource. Alchemy should retain visibility into Worker, D1, R2, queue, and other changes.

Alchemy's current D1 documentation covers database bindings, Effect clients, and migration application. Its Worker and queue APIs provide the underlying resource/binding composition. Pin the exact adapter integration versions and test them rather than copying historical examples across incompatible releases. [R01][R02]

Deployment creates only required resources, returns application URLs and handles, and supports externally supplied resources with explicit ownership/retention rules.

### AWS / CDK

`@forge/cdk` emits normal CDK constructs: DynamoDB TableV2, Lambda handlers/activities, API Gateway HTTP routes, S3, SQS, optional SNS/EventBridge, Step Functions Standard, and required roles/logging. CDK TableV2 is an available foundation; avoid inventing a separate provisioning engine. [R31]

A Forge database migration runner/backfill job is separate from CDK table creation. CDK does not migrate arbitrary application records automatically. Do not perform long-running data backfills synchronously inside a fragile stack custom-resource callback.

### Shared deployment concerns

Keep user-owned `deploy/` files separate from generated bundles and reviewed migrations. A full deployment has phases: provision additive infrastructure, apply compatible schema changes, deploy compatibility readers/writers, run backfills, switch traffic/read strategy, validate, and eventually clean up.

No cross-provider atomic deployment claim. Default retain authoritative databases/blobs; require explicit confirmation/configuration for destructive operations. Bootstrap defaults never overwrite live business-managed records during reconciliation.

Environment bindings and runtime secrets stay outside the public contract/IR. Compile-time adapters refer to secret identifiers, not values. Do not embed credentials in generated source.

## 22. Migrations and provider switching

Track API, event, storage, codec, lifecycle, and workflow compatibility separately. Adding an enum output member can break exhaustive consumers; making a field optional can break existing readers. Do not label all additive changes universally safe.

An explicit rename preserves stable identity. A constraint tightening requires validation/backfill. Codec or unit changes can require rewriting data even when the field's primitive storage type stays the same. Runtime must understand stored schema versions during a staged rollout.

Migrations are reviewed source-controlled artifacts with checksums and an execution ledger. Disposable generated output is not the only copy of migration history. Only one component applies a given migration stream; Drizzle Kit and an Alchemy/Forge runner must not independently race to own it.

Changing provider requires moving data; recompilation alone does not do that. Implement canonical export/import of authoritative resources, IDs, revisions, blob manifests/content digests, and selected history. Rebuild caches and projections. Stop or fence writes during a first migration; later online cutover needs an explicit change-capture/replication protocol. Validate counts, canonical hashes, relationships, and resource revisions before traffic cutover.

In-flight native workflows generally need to be drained, finished on the old provider, or explicitly restarted from a portable checkpoint. Native workflow history is not assumed portable. Replay outbox work only with preserved identities and correct delivery receipts.

## 23. Generic management UI and agent surface

Generate one UI descriptor and client for both targets. The first React workspace provides list/form editing, explicit edit buffers, field errors, relationship pickers, keyboard paste, multi-row changesets, preview/conflicts, history, and CSV import/export.

The UI never writes directly to D1 or Dynamo. Lifecycle fields are not arbitrary editable cells; permitted transitions appear as actions. Derived/read-only/server-owned fields are excluded from write contracts. Filters and “select all” must describe the actual server query or complete bounded working set, not only the current page.

Agent integrations use the same operations, schema descriptions, authorization, idempotency, and preview/commit flows. A later MCP emitter does not introduce a second privileged mutation path.

A typed product-feedback resource can capture an authorized user's unmet intent, operation/constraint IDs, and sanitized example. That is an optional application built on the framework, not mandatory telemetry of customer conversations.

## 24. Repository layout

```text
forge/
  Cargo.toml
  crates/
    forge-syntax/
    forge-semantic/
    forge-planner/
    forge-codegen/
    forge-cli/
  packages/
    runtime/
    codecs/
    contracts/
    d1/
    d1-drizzle/
    d1-effect-sql/
    dynamodb/
    cloudflare/
    aws/
    alchemy-cloudflare/
    cdk/
    react/
    testing/
  specs/
    language/
    ir/
    portable-profile/
    codecs/
  conformance/
    fixtures/
    scenarios/
    fault-injection/
  examples/
    acme/
    payments/
  migrations/
  docs/
```

Start with fewer internal packages if that improves iteration. Preserve these architectural boundaries even when code initially shares a crate/package. Use an established OSS license, security policy, versioned RFC process, contributor guide, and minimal public API policy. Review third-party dependencies and grid features for licensing compatibility before making them required.

## 25. Implementation milestones and acceptance gates

Milestones are ordered by dependency and risk, not calendar estimates. Each portable feature is incomplete until both deployed adapters pass it.

### M0 — Semantics and executable specifications

Deliver the language grammar, canonical wire format, portable profile, error taxonomy, codec vectors, operation state models, stable-ID rules, and dual-target test harness skeleton.

Run spikes on live D1 guarded batches and Dynamo conditional transactions, strong access items, concurrent uniqueness, parent deletion races, and outbox recovery. Decide supported versions for Rust, TypeScript, Effect, Alchemy, CDK, Cloudflare compatibility date, and AWS runtime.

**Gate:** the highest-risk commit protocols have small, passing executable tests. No compiler architecture is considered proven by a diagram.

### M1 — Compiler front end and package graph

Implement manifest/lock parsing, discovery, lossless syntax, symbol resolution, exports/imports, enums/types/shapes/resources, decorators, lifecycle elaboration, and JSON DomainIR. Add `forge fmt`, `forge check`, and `forge inspect`.

**Gate:** deterministic builds across directory order/platform path variations; stable diagnostic snapshots; invalid names/types/directions and missing initial assertions rejected. No deployment yet.

### M2 — Vertical CRUD parity

Compile Customer and Site into shared contracts, codecs, API/UI descriptors, D1 schema/queries, and Dynamo entity/unique/access plans. Implement create/read/update/delete, tenant isolation, defaults, unique constraints, safe queries, optimistic concurrency, and idempotency.

Provision actual Workers/D1 with Alchemy and HTTP API/Lambda/Dynamo with CDK. Do not defer one target.

**Gate:** one unchanged client and test suite passes sequential and concurrent CRUD scenarios against both endpoints. Plain CRUD has zero user handler files. No silent scans or missing constraints.

### M3 — Mutation integrity and domain CRUD

Add atomic audit/outbox, soft delete/restore, lifecycle actions, row/reference rules, changeset preview, atomic-budget reporting, and resumable bulk commits. Add both D1 runtime facades; ensure choosing Drizzle does not change semantics.

**Gate:** fault after database commit but before response/publication does not duplicate business mutations; failed preconditions leave no success audit/outbox; uniqueness/reference races pass on both targets.

### M4 — Business workspace, blobs, and CSV

Ship shared React form/grid and CSV import/export; R2/S3 upload intents, finalization, inspection jobs, mapping profiles, staging, errors, preview, and replay-safe commit.

**Gate:** the same file and edit sequence produce the same canonical records/rejections on both clouds; replacing a staging object after review cannot alter approved bytes; interrupted imports resume without duplicate effects.

### M5 — Channels, external bindings, and functions

Generate internal channels, subscriptions, fan-out, envelope codecs, outbox dispatch, deduplication, DLQs, and retries. Type-check `uses`/`sends`; add external HTTP/queue contracts and explicit adapter slots.

**Gate:** every subscription sees its logical messages independently; send/recv violations fail compilation; missing external mapping fails production build; external IDs are never guessed.

### M6 — Views, cache, projections, temporal/hierarchy

Implement bounded views, cache readers/freshness, projection contribution/checkpoint protocol and rebuilds, half-open effective dates, guarded overlap enforcement, and cycle-safe hierarchy moves.

**Gate:** stale-event and concurrent-move tests pass; expired cache values are rejected before physical cleanup; both query planners either satisfy the contract or reject it explicitly.

### M7 — Workflows and sources

Implement sequence/choice/bounded parallel/sleep/wait, stable activity IDs, signal inbox, timeout/cancellation rules, standard error mapping, UTC schedules, then timezone/DST support. Add the portable realtime profile after core workflows.

**Gate:** duplicate starts, early/late signals, retries, deployment upgrades, timeout races, and schedule occurrences conform on both platforms. Native workflow cancellation is not misrepresented as undoing completed effects.

### M8 — Observability, hardening, and release certification

Logical instrumentation begins in M2; this milestone completes SLO emitters, export-gap monitoring, lifecycle/jobs telemetry, compatibility tooling, data migration, limits/benchmarks, docs, LSP basics, packaging, and the complete Acme demo.

**Gate:** both targets pass the declared portable profile and emit a machine-readable conformance report. Performance is measured independently; target values are not advertised as achieved without results.

## 26. Test strategy: parity as an executable specification

Run the same scenarios against a deterministic in-memory semantic model, local D1/SQLite with each SQL facade, DynamoDB Local, and real deployed Cloudflare/AWS stacks. Local emulators accelerate development; cloud runs are required for real consistency, permissions, queue, workflow, and failure behavior.

Use seeded ID/clock services for deterministic functional tests. Run randomized concurrent histories and check invariants. Inject faults before/after commit, before/after acknowledgment, between fan-out recipients, during retry token expiration, and around signal registration. Compare normalized API results and durable business state.

Required suites include:

- Syntax, formatting, source maps, module moves, import visibility, enum wire identity, lifecycle inference.
- Codec cross-language round trips, money precision, null/absence, Unicode, sorting, units, ambiguous dates.
- Same unique value concurrent creation, soft-delete key retention, restore conflict, version conflict.
- Cross-tenant references/cursors/messages, direct field privilege escalation, read-only/lifecycle bypass attempts.
- Reference create versus parent deletion; cross-resource rule versus concurrent parent update.
- Failed conditional write leaves no audit/outbox; lost response with replayed key; receipt collision.
- Stable sequential pagination; documented behavior under concurrent inserts/moves/deletes; no hidden scans.
- Duplicate/out-of-order events; per-subscriber isolation; poison messages; long outage and outbox sweep.
- Upload overwrite/finalization races, chunk limits, multi-line CSV, malformed file, resumable import.
- Cache expiry before cleanup, invalidation races, effective-boundary rollover, source failure fallback.
- Projection stale events, double-delivery, deletion, rebuild during declared write fence.
- Effective interval races and hierarchy cycles under concurrent writers.
- Workflow retries, early signals, stale tokens, timeout races, version pinning, large payload rejection.
- Cron/DST semantics, websocket reconnect contracts, telemetry cardinality and SLO classification.
- D1/Drizzle versus D1/Effect SQL versus Dynamo behavior; cross-provider canonical export/import.

Golden OpenAPI, UI, message, and client artifacts must match independent of provider. Physical plan snapshots intentionally differ. Test provider constraints such as D1 parameters and Dynamo transaction actions at just-below/at/above boundaries.

## 27. Risks and explicit non-goals

The largest engineering risks are semantic drift between adapters, write amplification/guard contention on Dynamo, correctness of D1 conditional batches, expression/codec parity, source-data race handling, and workflow upgrades. Resolve these before spending heavily on editor polish or broad import formats.

Do not build a general-purpose programming language, universal SQL optimizer, new workflow engine, new IaC state system, hosted analytics database, package registry, or fully automatic identity mapper in the first release. Do not advertise arbitrary cross-cloud distributed transactions.

Do not infer runtime safety merely from `uses`; handwritten code can violate declarations without static restrictions, tests, and actual permission boundaries. Do not claim a lifecycle proves business correctness beyond the declared transitions/guards.

Do not call a feature portable simply because one target can emulate it by scanning unbounded data. Bounded emulation is valid when its bound and cost are part of the plan.

## 28. Definition of done for the reference application

Acme's operators manage Customers, Sites, effective-dated policies, Orders, and attachments from the same generated workspace. Named enums, semantic types, relationships, lifecycle actions, imports, conflicts, and audit are visible. The same client calls either endpoint without changing data contracts.

An order transition atomically updates state and stages its event. The event reaches independent fulfillment and summary subscriptions. A workflow survives retries and a payment signal race. A customer-order projection is rebuildable; a current-policy cache respects the next effective boundary. An uploaded document becomes readable only after finalization. Traces and SLIs identify the same logical operations on both clouds.

Run this application once on Alchemy + D1/R2/Queues/Workers/Workflows and once on CDK + DynamoDB/S3/SQS/Lambda/Step Functions. Preserve the same `.forge` package, canonical API/client, and application implementation sources. Only target deployment/binding modules change.

**The release claim is earned by this demonstration and the conformance suite—not by producing two sets of infrastructure templates.**

## 29. Research references

Primary documentation checked on 17 September 2026. Provider limits and library APIs can change; pin versions and capability manifests in implementation. References support existing-tool facts, not the proposed Forge APIs.

- **R01 — Alchemy D1:** https://alchemy.run/cloudflare/data/d1/
- **R02 — Alchemy Workers and Queues:** https://alchemy.run/cloudflare/compute/workers/ ; https://alchemy.run/cloudflare/messaging/queues/
- **R03 — DynamoDB transaction behavior:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
- **R04 — D1 batch and Sessions API:** https://developers.cloudflare.com/d1/worker-api/d1-database/
- **R05 — D1 limits:** https://developers.cloudflare.com/d1/platform/limits/
- **R06 — DynamoDB constraints:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html
- **R07 — DynamoDB read consistency:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html
- **R08 — DynamoDB Query filtering:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.FilterExpression.html
- **R09 — DynamoDB unique-claim pattern:** https://aws.amazon.com/blogs/database/simulating-amazon-dynamodb-unique-constraints-using-transactions/
- **R10 — Effect introduction and Schema API:** https://effect.website/docs/v4/onboarding ; https://effect.website/docs/v4/api/effect/Schema
- **R11 — Cloudflare Queue consumers:** https://developers.cloudflare.com/queues/reference/how-queues-works/
- **R12 — Cloudflare delivery and limits:** https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ; https://developers.cloudflare.com/queues/platform/limits/
- **R13 — Lambda with SQS:** https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
- **R14 — Cloudflare Workflow events:** https://developers.cloudflare.com/workflows/build/events-and-parameters/
- **R15 — Step Functions integration patterns:** https://docs.aws.amazon.com/step-functions/latest/dg/connect-to-resource.html
- **R16 — R2 presigned URLs:** https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- **R17 — S3 presigned URLs:** https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
- **R18 — KV consistency:** https://developers.cloudflare.com/kv/concepts/how-kv-works/
- **R19 — DynamoDB TTL:** https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html
- **R20 — Cloudflare Cron Triggers:** https://developers.cloudflare.com/workers/configuration/cron-triggers/
- **R21 — EventBridge Scheduler schedules:** https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html
- **R22 — Cloudflare native OTLP export:** https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- **R23 — OTel HTTP metrics:** https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
- **R24 — OTel messaging spans:** https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
- **R25 — Logos:** https://docs.rs/logos/latest/logos/
- **R26 — Rowan:** https://docs.rs/rowan/latest/rowan/
- **R27 — Serde:** https://serde.rs/
- **R28 — HTTP semantics / If-Match:** https://www.rfc-editor.org/rfc/rfc9110.html
- **R29 — HTTP 428 Precondition Required:** https://www.rfc-editor.org/rfc/rfc6585.html
- **R30 — Problem Details:** https://www.rfc-editor.org/rfc/rfc9457.html
- **R31 — AWS CDK TableV2:** https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_dynamodb.TableV2.html
