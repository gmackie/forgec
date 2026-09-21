# Forge: post-M8 portability and governed-capability implementation plan

**Plan date:** 20 September 2026  
**Baseline:** *Forge: dual-target compiler and application runtime*, 17 September 2026, through milestone M8.  
**New implementation milestones:** M9–M21.  
**Compiler:** Rust. **Reference application runtime:** TypeScript + Effect.  
**Status:** proposed implementation roadmap, specifications, and acceptance criteria. Neither this document nor its examples establish that M8 has been implemented or that any new cloud integration has passed certification.

## Executive decision

Evolve Forge from a dual-target application compiler into a **portable, governed application-contract system**. Preserve the original deterministic CRUD and mutation engine. Add independent storage/runtime/deployment adapters, purpose-scoped capabilities, a faceted data vocabulary, open interface generation, and an optional registry whose indexed artifacts supply Gatekeeper's action catalog.

The critical runtime invariant is:

> An invocation may use only the operations, fields, rows, relationships, and outbound disclosures permitted by its compiled capability surface **and** its currently applicable authorization constraints. Changing storage, compute, or deployment tooling must not widen that authority.

This is a bounded engineering guarantee, not a claim to prove arbitrary handwritten TypeScript, a person's true intent, or legal compliance. The framework must report the boundary, assumptions, unmodeled flows, and evidence behind each claim.

The work is an extension of M8, not a new greenfield plan. The baseline's **26 work items (FORGE-001–026) and 75 scenarios (PAR-001–075)** remain intact. New work and tests use subsequent IDs. A baseline gate checks the actual implementation before downstream release claims are made. [B01][B02]

## Reading map

| Section | Implementation question |
|---|---|
| 1–3 | What changes after M8, and which earlier sketches are superseded? |
| 4–6 | How do compiler plans, adapters, PostgreSQL, and the Effect runtime fit together? |
| 7–9 | How do classification, purpose, and composable capabilities become enforceable? |
| 10–12 | How do authentication, Gatekeeper, registry publication, and dependency approval work? |
| 13–15 | How do open interfaces, semantic diffs, migrations, and subject-rights workflows work? |
| 16–18 | How are observability, evidence, and the Acme reference application extended? |
| 19–22 | What must each milestone deliver, in what order, and how is it tested? |
| 23–25 | How does the existing framework migrate, what stays deferred, and what constitutes release? |

The accompanying `specs/` files contain the dependency-ordered backlog, baseline-to-extension traceability, and new conformance scenarios. Examples are draft syntax fixtures, not generated or compiled applications.

---

## 1. M8 baseline and scope of this extension

### 1.1 Preserve the baseline

The original plan already requires separate Domain/Mutation/Query/Relational/Dynamo plans, shared application semantics, generated CRUD without user handlers, strict codecs, nominal references, guarded mutation integrity, audit/outbox co-commit, import sealing, workflow signal inboxes, and independently measured backend performance. M8 completes observability, compatibility, migration, packaging, and certification. Do not reclassify those as new post-M8 inventions. [B01 §§2–3, 7–22, 25–28]

Before refactoring, capture the last accepted M8 artifacts, generated client, wire-format goldens, database baselines, runtime versions, compiler build, deployment manifests, and conformance evidence. If an M8 gate has not passed, record the gap and carry it as a blocking predecessor rather than assuming it away.

### 1.2 Add or materially deepen

The extension covers:

- Independent **database engine, managed provider, connection strategy, query facade, compute runtime, messaging/workflow adapter, and deployment tool** choices.
- PostgreSQL and a real Node/self-hosted runtime, followed by tested Neon, PlanetScale Postgres, and Turso profiles; Terraform and Nix/Docker packaging.
- Imported callable contracts across local Effect, HTTP, Cloudflare RPC, Lambda invocation, and later additional RPC protocols.
- OpenAPI foreign-package import, Smithy/OpenAPI export, generated MCP and API CLI interfaces, and authenticated discovery.
- Registry publication, searchable contract/action catalog, deployment inventory, Gatekeeper reconciliation, and callee-owned dependency-grant PRs.
- Data classification, subject bindings, conservative lineage, handling requirements, purpose declarations, composable capability surfaces, and scoped output/input types.
- A provider-independent authentication/authorization contract, typed PIPs, delegated authority, revocation, and policy-aware queries.
- Commit-to-commit semantic diffs, business-readable PRs/changelogs, deployment compatibility, and staged governance/data migrations.
- Governed retention, subject-access/erasure workflows, recovery controls, generated engineering dashboards, and bounded compliance evidence.

### 1.3 Keep the nine application constructs

`resource`, `blob`, `cache`, `view`, `projection`, `function`, `workflow`, `channel`, and `source` remain the application topology vocabulary. `type`, `enum`, `shape`, and `error` describe values. `purpose`, `dataClass`, reusable resource-local `capability` declarations, identity contracts, and reviewed `grant` declarations belong to cross-cutting contract/governance namespaces; they are not new storage or compute services.

Do not introduce a required `service` primitive, another workflow engine, another IaC state backend, or a universal query language. An external service is a package of imported callable/resource/channel contracts with explicit realizations.

## 2. Normative decisions and corrections to earlier sketches

These decisions resolve conversational examples that were intentionally exploratory.

| ID | Decision |
|---|---|
| D01 | M0–M8 remain the regression baseline; no unverified implementation status is assumed. |
| D02 | Pure compilation is offline and deterministic. Fetch/update/publish/deploy are distinct effectful commands. |
| D03 | Folder moves do not change semantic IDs; package/module identity is explicit and versioned. |
| D04 | `source` remains intrinsically one-way. HTTP/MCP request-response and WebSocket duplex interfaces are bindings, not redefinitions of source. |
| D05 | `function` is a typed callable contract; implementation location and RPC transport are realization details. Remote invocation failures remain explicit. |
| D06 | `uses` declares potential effects/dependencies, not unconditional execution, identity proof, or consent. |
| D07 | Purpose taxonomy inheritance describes meaning; it grants **no automatic field/action authority**. Capability inheritance is explicit and separately reviewed. |
| D08 | Resource-local capability inclusion combines grants; all inherited denials remain sticky. Read, create, update, query, export, and actions are distinct permissions. |
| D09 | Runtime restrictions intersect with the static ceiling. They do not union purposes or add authority. |
| D10 | Effect service keys enforce developer-facing separation; request-scoped wrappers enforce runtime checks. Installing a Layer once is not authorization for every row forever. |
| D11 | Classification describes data, not access rights. Legal basis, purpose, record context, identifiability, and handling requirements are separate facets. |
| D12 | Unknown/unclassified is not public. Redaction, hashing, aggregation, encryption, and tokenization do not automatically remove personal-data lineage. |
| D13 | Static lineage describes possible flows; validated runtime receipts describe observed flows. Neither alone proves universal flow completeness. |
| D14 | The registry supplies immutable contracts and a derived catalog. Grants, deployed instances, health, and runtime evidence are separate authoritative records with their own provenance. |
| D15 | A dependency request does not grant access. The callee's protected repository approves the edge; runtime activation verifies matching approved artifacts. |
| D16 | Workload identity does not prove which function inside a shared process executed. Strict function isolation requires a separately attested execution boundary. |
| D17 | Signed snapshots require freshness, trust-root, revocation, and rollback protection. Signature validity alone does not establish current authority. |
| D18 | Semantic diff never invents live row counts, confirms legal compatibility, or declares arbitrary Rego changes wider/narrower without evidence. |
| D19 | Cross-language SDK support is certified per generator/protocol/language tuple, not advertised as every language automatically. Server-runtime portability remains Effect/TS initially. |
| D20 | Compliance evidence is scoped and conditional. Add `unknown`, `external evidence required`, and `coverage gap` states; do not infer safety from absence of telemetry. |
| D21 | A soft delete is not erasure; a retained keyed subject hash is usually still linkable and must receive its own access/retention controls. |
| D22 | New adapters must pass named capability profiles. A provider brand or SQL-compatible label is insufficient evidence of parity. |

The baseline already makes several of these corrections, including source direction, folder identity, reference-versus-record types, and the distinction between API preconditions and business conflicts. Preserve its HTTP `If-Match` handling: failed preconditions map to 412; missing required preconditions to 428. [B01 §§4–5, 12]

## 3. Product boundaries and certification profiles

### 3.1 Independently selectable axes

A deployment selects the following dimensions through reviewed deployment configuration, not business `.forge` definitions:

| Axis | Initial / new choices |
|---|---|
| Structured-state engine | Existing D1/SQLite profile and DynamoDB; add PostgreSQL. |
| Database provider | Customer-supplied instance, Cloudflare D1, AWS DynamoDB, managed Postgres providers, specified Turso engine/API. |
| Connection | Native binding, TCP/pool, Hyperdrive, vendor HTTP/WebSocket driver. |
| SQL facade | Effect SQL or Drizzle; same checked plan semantics and migration authority. |
| Compute | Workers, Lambda, Node processes/containers. |
| Blob / messaging / workflow | R2/S3/filesystem; Queues/SQS/other certified transports; Workflows/Step Functions/Temporal adapter. |
| Deployment | Alchemy, CDK, Terraform, Compose, NixOS/systemd, or attach-existing. |
| Authorization | Local tested authorizer, OPA bundle runtime, or Gatekeeper. Same decision contract. |
| Interfaces | HTTP, selected RPC, MCP, generated API CLI, language SDKs. |

A PostgreSQL resource on Workers still uses a PostgreSQL mutation plan, not a D1 plan with its name changed. A Terraform deployment of AWS still uses the same AWS runtime/storage plans as the CDK realization. Not every combination is meaningful or supported; the planner resolves a valid composition or reports the missing capability.

### 3.2 Release profile matrix

All entries below are **implementation targets**, not currently certified claims.

| Profile | Compute / state / provisioning | Required release coverage |
|---|---|---|
| P1 | Workers + D1 + Alchemy | Preserve complete M8 profile; add governance-v1. |
| P2 | Lambda + DynamoDB + CDK | Preserve complete M8 profile; add governance-v1. |
| P3 | Workers + PostgreSQL through a tested connection + Alchemy | Same CRUD/governance contracts; workflows remain native Cloudflare. |
| P4 | Lambda + PostgreSQL + CDK | Same CRUD/governance contracts; workflows remain Step Functions Standard. |
| P5 | Node + PostgreSQL + Compose / existing services | Full governed CRUD, messaging and interfaces; full-workflow profile adds a certified Temporal adapter. |
| P6 | Node + PostgreSQL + NixOS/systemd | Same artifacts and runtime behavior as P5; packaging/operations separately certified. |
| P7 | AWS baseline physical plan through Terraform | P2-equivalent runtime contract and explicit state-owner handoff tests. |
| P8 | Cloudflare baseline physical plan through Terraform | P1-equivalent runtime contract where the pinned provider supports required resources. |
| Provider extensions | Neon Postgres, PlanetScale Postgres, Turso pinned API/engine | Engine/connection suites plus documented limits and provider-specific tests; no automatic promotion. |

Preserve the initial single-authority deployment scope. No active-active cross-cloud write promise, portable native workflow history, identical performance, or instantaneous cross-provider cutover is added.

The supported capability set is a versioned intersection of engine, provider, driver, compute environment, adapter implementation, deployment configuration, and tested operating envelope—not a bag of booleans such as `transactions: true`.

### 3.3 Capability manifest

Each adapter publishes a declarative manifest with identity/digest, runtime and engine versions, operation support, isolation/consistency modes, atomic action/byte limits, connection lifetime rules, DDL restrictions, storage ownership, residency observations, and conformance evidence references. Each requirement resolution records one of `native`, `bounded-emulation`, `unsupported`, or `unknown` with its assumptions and proof obligations.

No plugin may self-certify by returning `true`. The signed evidence references must identify a tested adapter build and profile. A changed driver version invalidates only the evidence affected by that change, not silently all claims or none.

## 4. Compiler and IR evolution

### 4.1 Extend the existing semantic graph

Keep one stable symbol graph. New IRs are versioned projections, not separate competing definitions or a reason to create dozens of empty crates.

```text
.forge + forge.toml + forge.lock + pinned foreign contracts
                          |
                 Rust semantic compiler
                          |
         DomainIR / CodecIR / ConstraintIR / OperationIR
                          |
        +-----------------+------------------+
        |                 |                  |
 DataSemanticsIR    Purpose/CapabilityIR    InterfaceIR
 LineageIR         AuthorizationIR         ForeignPackageIR
        |                 |                  |
        +-----------------+------------------+
                          |
                Secured operation plans
                          |
       MutationIR / QueryIR / ExecutionIR / MessagingIR
                          |
       +------------------+------------------+
       |                  |                  |
 RelationalIR         DynamoIR          Runtime/RPC plans
       |
 Sqlite/D1 or PostgreSQL dialect plans
                          |
           Capability resolution / PhysicalPlanIR
                          |
            Alchemy / CDK / Terraform / host packaging

Cross-cutting outputs: semantic diff, migration/rollout plan,
registry manifest, discovery, OTel/SLO/dashboard plans, evidence.
```

Security/classification specialization runs **before** interface generation and query lowering. Generating a full-record API first and redacting it as an afterthought is not the architecture.

### 4.2 Required IR additions

| IR / record | Required contents |
|---|---|
| `DataSemanticsIR` | Kinds, subject bindings, identifiability, origin, context, handling, transformation and evidence references, completeness state. |
| `PurposeIR` | Stable purpose ID, definitions, taxonomy parents, declared compound activities, legal-basis references kept separate. |
| `CapabilityIR` | Resource-local fragments, inclusion graph, grant/deny atoms, nested-path bounds, query permissions and named actions. |
| `EffectiveCapabilityIR` | Flattened purpose/resource surface, origin of every permission, explicit field schemas, surface digest. |
| `AuthorizationIR` | Policy attachment, typed request/environment, PIP requirements, obligations, revocation/freshness rules, query-filter subset. |
| `ForeignPackageIR` | Imported types/functions/webhooks, origin pointers, serialization/security requirements, unsupported constructs, source hashes. |
| `InterfaceIR` | Concrete exposed operations, selected purpose surfaces, codecs/errors, protocols, CLI/MCP names, auth/discovery links. |
| `AdapterRequirementIR` | Exact engine/runtime/transport requirements and operating bounds, not provider name alone. |
| `RegistryManifest` | Immutable public symbols, edges, schemas and hashes; never credentials or business rows. |
| `DeploymentDescriptor` | Environment-specific endpoints, artifact/adapter/grant/policy digests, ownership, observed state and update provenance. |
| `GrantRequest` / `Grant` | Caller/callee action and package identities, reviewed effect/purpose envelope, environment/audience, approved artifacts, lifecycle. |
| `SemanticDiffIR` | Typed changes, directional compatibility, uncertainty, source locations and known dependency scope. |
| `RolloutPlanIR` | State machine of additive rollout, backfill, policy/grant activation, verification, traffic change, drain, cleanup. |
| `EvidenceIR` | Claim, scope, assumptions, static proof/test/observation/attestation type, freshness, gaps and assessor provenance. |

Serialization includes format version and stable IDs. Exact compatibility of payloads is separate from full artifact-hash equality. Source/docs-only changes may alter the source digest without altering the operation wire digest. Security/governance changes may require reapproval even when the wire digest is identical.

### 4.3 Deterministic hashing and lineage IDs

Use explicit canonical serialization with domain-separated hashes for: value schema, operation wire contract, capability surface, governance semantics, dependency effect envelope, implementation artifact, and physical deployment plan. Preserve distinctions between ordered arrays and mathematical sets. Record normalization/codec and taxonomy package versions in the relevant hashes.

Stable field IDs are explicit durable lineage, not random IDs regenerated during compilation. A rename mapping is reviewed source metadata. Moving a file or changing a display label never implicitly changes field identity, route identity, grants, or physical resource names.

Importing a package acquires no authority and executes no plugin code. Build-time plugins are pinned, allowlisted, and run outside the pure compiler with bounded filesystem/network capabilities. Untrusted PR compilation uses read-only source, resource limits, and no production secrets.

## 5. Storage and deployment independence

### 5.1 Refactor the M8 adapter boundary

Extract the current `cloudflare-d1` and `aws-dynamodb` bundles into composed providers while preserving facade exports for old callers. Runtime code consumes structured-store/blob/cache/channel/workflow interfaces. Deployment code consumes physical-plan records. One compatibility shim keeps M8 applications building while adapters are separated.

The public surface should express named capabilities such as `executeGuardedMutation`, `executeAuthorizedQuery`, `sealObject`, `publishEnvelope`, and `startWorkflow`; it should not pretend a single generic `get/put` client captures integrity, disclosure, or transaction semantics.

Storage adapters must report which columns/attributes are selected and materialized, including secondary access items and audit/outbox copies. Governance can then distinguish **bytes fetched by trusted storage infrastructure** from **fields disclosed to business implementation or an external recipient**. A Dynamo projection expression can limit returned attributes but does not mean disallowed attributes cease to exist in the underlying stored item.

### 5.2 PostgreSQL work

Add PostgreSQL dialect lowering for schema, constraints, named access plans, transactional guarded writes, outbox/receipts, projection generations, temporal/hierarchy guards, and migration phases. Begin with the M8 exact numeric and collation semantics; do not silently widen a PostgreSQL profile and claim its wider values are still D1-compatible.

Implement Effect SQL and Drizzle facades over the same secured operation plans. Use parameterized, allowlisted SQL; return validated canonical values. Add transaction retry handling for known serialization conflicts while preserving logical idempotency and avoiding automatic retries of stale user versions.

RLS can add defense in depth but is not the sole policy system. PostgreSQL documents that owners normally bypass RLS and that superusers/BYPASSRLS roles bypass it. Use separate migration/runtime roles, and test pooled connections for identity leakage; transaction-local context must be cleared on every exit path. [R03]

Connection capabilities are tested separately. Hyperdrive provides query caching, with a documented cache-disabled binding appropriate for authorization and reads after writes; use the verified no-cache path for strict reads and commit-time guards. [R04] Neon exposes HTTP and WebSocket connection modes; certify the actual transactional semantics of the selected mode, rather than treating every serverless driver as an interactive database session. [R05]

### 5.3 Managed providers

Implement provider *attach-existing* support before complex provisioning automation. A provider result supplies an engine-qualified database handle, secret references, endpoint/connection constraints, branch/admin capabilities, and ownership metadata.

Neon and PlanetScale Postgres reuse PostgreSQL lowering but receive separate driver/provider certification. PlanetScale has a documented Postgres offering; a Vitess/MySQL profile would require distinct lowering and sharding/constraint analysis, not reuse of the Postgres certificate. [R06]

Turso receives an explicitly named/versioned engine and SDK profile. Its documented TypeScript/libSQL interfaces are not proof of interchangeable behavior with D1. Test transactions, constraints, data types, batch limits, read consistency, and migration failure before enabling the profile. Do not depend on announced compatibility or future product roadmaps. [R07]

### 5.4 Node, Docker, Nix, and Terraform

Node runs the shared Effect business/runtime layer behind a Fetch-compatible HTTP host, independent job consumers and tested RPC adapters. Package API and worker processes separately when their trust/resource limits differ. Add graceful drain, readiness, idempotent startup, migration separation, and observability export.

Compose packages the Node artifact and explicitly chosen supporting services. A full durable-workflow profile uses a tested Temporal adapter; an in-memory test executor must never advertise production durability. Temporal's durable execution model is the external runtime being adapted, not a reason to implement a new Forge engine. [R08]

Nix pins build inputs and packages services/systemd units. Keep secret material out of derivations, build outputs, and the Nix store; runtime secret injection is a separate host capability. Nix support is a packaging/operations target, not evidence of backup or privacy controls by itself. [R09]

Terraform consumes resolved provider-specific physical-plan IR. Initially emit `.tf.json`, an officially supported machine-generated configuration syntax. [R10] Pin provider schemas and external artifact hashes. Do not perform data backfills through generic shell provisioners or conceal them in cloud stack callbacks.

A physical resource has exactly one IaC state owner. Switching Alchemy/CDK/Terraform requires an explicit import/adoption/handoff procedure, plan verification and locking. Two engines must not reconcile the same resource simultaneously. Default deletion policy retains authoritative databases/blobs; external resources are not destroyed by Forge.

## 6. Effect application runtime and trusted context

### 6.1 Service identity and lifetime

A generated capability has a nominal runtime service key derived from stable resource/action + purpose + surface version. It must not be a generic parameter erased at runtime over one universal service key.

Effect services place dependencies in `Effect<Success, Error, Requirements>`, and Layers supply implementations. Layer construction can be memoized. Forge should exploit that for infrastructure clients, not for user-specific authorization state. [R01][R02]

Separate:

```text
Process scope: driver pools, immutable descriptors, policy verifier,
               safe snapshot caches, exporter clients.

Invocation scope: authenticated subject, immediate workload/actor,
                  effective purpose, delegation, tenant, deadline,
                  restrictions, budget and request identity.

Operation scope: concrete resource/rows, requested fields, old/new
                 state, PIP evidence, policy decision, obligations.
```

A reader supplied to the current invocation is still a **guarded reader**. `reader.get(recordId)` evaluates record-dependent policy and current restrictions. Creating a Layer cannot preauthorize IDs not yet known.

### 6.2 Context contract

Define trusted `InvocationContext` with issuer-qualified subject identity, initiating principal where applicable, immediate workload/actor identity, verified delegation chain, tenant, accepted root/effective purpose, scope restrictions, deadline, logical request ID, trace context, contract/snapshot references, and privilege mode.

Raw JWT claims and user-provided `purpose`, `tenant`, `clearance`, or `callerFunction` headers are untrusted input. Authentication and binding adapters verify and map them. OTel baggage is not an authorization channel; its documented propagation/security caveats require an explicit export allowlist. [R11]

Clock, IDs, feature evaluation and secret/crypto callables are injectable services. Do not add arbitrary ambient context into cache keys implicitly; derive and explain the security/freshness fingerprint for each cached result.

### 6.3 Calls and remote realization

`uses payments.AuthorizePayment for PaymentProcessing` yields a callable capability. Its implementation may be local, Worker RPC, Lambda invocation, HTTP, or a tested future protocol. Every remote result is decoded into the same result/error contract. Transport timeout, cancellation, uncertain commit, overload, and protocol violations are modeled invocation failures, not fabricated business errors.

Local calls cannot bypass the same operation boundary used remotely. Source impersonation and purpose changes are not implemented by mutating an ambient string. Entering another approved purpose creates a child invocation with its own bounded authority and auditable origin.

Only the receiver's policy can authorize independent service authority. Delegating user authority never broadens the user's approved envelope. A background system process may use separately granted service authority; it must not label that as the original user's perpetual consent.

## 7. Faceted data classification and lineage

### 7.1 Taxonomy model

A single `pii: true` flag cannot represent a school record, an industrial recipe, a customer contact, and a signing key. Implement independent facets with namespaced IDs, versioned definitions, aliases, and source provenance.

| Facet | Meaning and implementation |
|---|---|
| Semantic kinds | Multi-label vocabulary of identity, contact, identifier, health, education, finance, asset, operational, intellectual-property, security, etc. |
| Subject bindings | The actual person/organization/device/process reference the value concerns; may have multiple subjects and roles. |
| Identifiability | Context-sensitive direct/indirect/linkable/pseudonymous characteristics; unknown allowed. |
| Origin | Subject-provided, observed, inferred, derived, external or generated, with source references. |
| Record context | Education, healthcare, employment, industrial, finance, and organizational extensions. |
| Handling | Organization-defined confidentiality lattice/compartments plus integrity/availability requirements; not lexical string comparison. |
| Transformations | Versioned redaction, tokenization, generalization, aggregation or encryption processes; no automatic anonymity claim. |
| Evidence | Declared, inferred-from-type, inherited, detected, reviewed, with authority/confidence/time where meaningful. |
| Obligations | References to retention, residency, permitted processing and disclosure rules; independently versioned. |

DPV is useful vocabulary input because it distinguishes purposes, processing, data categories, legal bases and safeguards. Its published v2 document is a Community Group Report, not a W3C Recommendation; import it as a pinned mapping vocabulary, not a legal authority. [R12]

Ship a small `@forge/data-core` package and optional industry vocabularies. Domain teams extend classes without changing the compiler. Taxonomy parentage can support category matching, but a custom subtype cannot remove inherited classifications or automatically inherit consent/access grants.

### 7.2 Proposed declaration surface

```forge
purpose CustomerSupport
purpose ParentCommunication

dataClass CustomerEmail extends data.contact.email

type CustomerEmailValue = email @data(CustomerEmail)

resource Contact
  @tenant
  @timestamps
  @versioned
  @audited
  @purposeScoped
  @subject(person)
{
  id : id
  customer : Customer
  name : personName
  email : CustomerEmailValue
  notes : text? @data(data.communication.content)
}
```

In this example `Contact` is a person and `Customer` is an organization. Do not model every Acme customer as a GDPR data subject or erase an entire organization when a person's email is erased. For related records, use an explicit binding such as `@subject(from: contact)`. A guardian email needs a concrete guardian relationship/subject binding, not only a string role saying `Guardian`.

Semantic types contribute known kinds; their annotations remain inspectable and override rules are monotone. Unknown fields and unclassified free text fail the strict governed-export profile until reviewed or assigned a conservative handling rule. Sensitive values are not embedded in taxonomy examples, manifests, hashes of low-entropy secrets, or diagnostics.

### 7.3 Declared schema versus observed content

A schema classification is authoritative design metadata. A detector finding is evidence about a particular value/version and may have false positives or false negatives. Keep them separate. A detector cannot downgrade a declared classification or mark a scan failure safe.

For blobs, classify both declared content policy and detected contained data. Define `pending`, `allowed`, `quarantined`, and `review-required` inspection states. Inspection must bind the sealed object digest/generation. Read and export paths honor the verdict; merely requesting an upload URL does not clear the file.

### 7.4 Lineage is not just return fields

Generate conservative field dependencies for projections, expressions, joins, grouping keys, predicates, order keys, branch conditions, and emitted payloads. A result can reveal a restricted fact through count, existence, grouping, or filtering even when the sensitive column is absent from `SELECT`.

Generated operations have exact modeled field flow. Handwritten functions declare bounded data-effect contracts and external sinks; the compiler records them as declared, not proven. Runtime wrappers produce disclosure receipts where supported. Raw SDK/file/log/network escape hatches create explicit coverage gaps and invalidate stronger information-flow claims for that implementation.

Required lineage edges include authoritative rows, Dynamo access items, denormalized SQL columns, audit diffs, idempotency results, outbox/inbox/DLQ payloads, workflow step results, sealed originals, normalized imports, caches, exports, backups and external disclosures. Projections remain derived; they do not silently become anonymized data.

## 8. Purpose and capability composition

### 8.1 Purpose is intent context, not an access grant

A purpose is a stable typed business objective. It is distinct from legal basis and authentication. A signed invocation asserts that a trusted runtime selected an allowed purpose; it cannot prove the human or program's true motivation.

```forge
purpose ServiceProvision
purpose CustomerSupport extends ServiceProvision
purpose ParentCommunication extends ServiceProvision
purpose StudentFamilySupport {
  includes CustomerSupport
  includes ParentCommunication
}
```

`extends` and purpose-level `includes` describe vocabulary/activity relationships only. Neither automatically unions or inherits authority. A compound activity requires its own explicit resource surfaces and dependency grants. This corrects earlier sketches that conflated semantic specialization with permission inheritance.

### 8.2 Resource-local capabilities

```forge
resource Contact
  @tenant
  @versioned
  @purposeScoped
{
  id : id
  customer : Customer
  name : personName
  email : email
  supportNotes : text? @data(data.communication.content)

  capability Identity {
    read { id name }
  }

  capability ContactRead {
    includes Identity
    read { customer email }
    filter { customer }
  }

  capability ContactMaintenance {
    includes ContactRead
    update { email }
  }

  capability SupportRecord {
    includes ContactMaintenance
    read { supportNotes }
    update { supportNotes }
  }

  capability AgentSupport {
    includes SupportRecord
    deny read { supportNotes }
    deny update { supportNotes }
    deny actions { export }
  }

  for CustomerSupport { use SupportRecord }
  for ParentCommunication { use ContactRead }
}
```

The example is a **syntax proposal** to implement in M12. It does not imply that every API exposed to a human automatically becomes available to their agent. Agent restrictions are an independent dynamic/static audience overlay; the `AgentSupport` fragment must be selected explicitly for an agent-specific surface.

Add `create` and `update` field permissions, not one ambiguous `write`. Retain old `write` only as documented sugar expanding into those field operations. Read is never implied by update. `export` is separate from read. A named action has its own declared effect envelope and output surface.

### 8.3 Normative algebra

Represent grants and denials as atoms: `(resource, operation, field-path)` or `(resource, named-action)`, plus constrained query/relationship capabilities. Inclusion is acyclic, deterministic, and independent of source order.

For a capability C:

```text
allowClosure(C) = localAllows(C) union all included allowClosures
 denyClosure(C) = localDenies(C) union all included denyClosures
        surface(C) = allowClosure(C) minus denyClosure(C)
```

Keep the denial closure after flattening so another include cannot reintroduce a prohibited atom. Namespace and resource target must match. Reject ambiguous action collisions, missing fields, unsupported nested patterns, and composition cycles.

Explicit reviewed capabilities may combine surfaces. Runtime authorization computes only intersections/restrictions:

```text
EffectiveAuthority = DeclaredUses
                   ∩ PurposeSurface
                   ∩ InterfaceExposure
                   ∩ ApprovedDependencyEnvelope
                   ∩ PrincipalAndActorPolicy
                   ∩ TenantAndResourceScope
                   ∩ ApplicableSubjectRestrictions
```

This expression is conceptual: not every operation requires a cross-service grant, and consent is only one possible applicable constraint, not a universal legal requirement. Deny, unknown-required-attribute, expired grant or unsatisfied obligation prevents execution.

Generic field-update permission and named domain actions are intentionally different. An approved `resetPassword` command may update a server-owned field without granting arbitrary password editing; the action's declared effects and handling obligations remain policy inputs. An explicit prohibition on processing a data category must be checked against action effects, not bypassed by command naming.

### 8.4 Generated types and representation

Use `Contact.Record<ParentCommunication>` in Forge as a generated concrete purpose projection. Emit nominal TypeScript services such as `ContactParentCommunicationReader` with only permitted operations and return fields. API schemas, Smithy structures, CLI output and MCP tools use the same flattened surface.

A purpose-scoped operation must not declare an unscoped full `Contact.Record` output. The compiler rejects it or requires an explicit privileged maintenance surface. Narrowing a TypeScript type by casting a full object does not remove fields; construct a checked output object and validate again at serialization.

Use stable concrete purpose/audience schemas. Dynamic policies may allow or deny a record/operation or narrow query scope. If a policy wants extra field redaction that would violate the promised required output schema, select a separately declared variant or reject the response; do not silently omit required properties while claiming the original type.

### 8.5 Query authority and relationship closure

Readable fields are not automatically filterable/orderable/groupable. A hidden field must not become an inference oracle through search, count, sort, grouping, error messages, pagination totals or uniqueness diagnostics. Declare and authorize query capabilities; legitimate intentional declassification such as a approved aggregate is a distinct reviewed capability.

Reading a resource reference does not authorize dereferencing it. `expand` requires a named target surface and row policy. Joined records, nested arrays/maps and polymorphic variants are recursively projected with explicit depth/cost limits. Prefer paginated linked reads over infinite recursive shapes.

Trusted authorization internals may access minimum needed policy attributes that the business function cannot see. Model that evaluator-only processing and its audit/retention consequences separately; do not leak policy values in denial messages.

### 8.6 Purpose changes, asynchronous work, and caches

A dependency can specify `for OtherPurpose`. The edge must be explicitly declared and approved, with recipient-specific input minimization. Do not carry the union of all caller fields into the child. Purpose taxonomy descent alone does not authorize that transition.

Queue/workflow records carry validated purpose, grant/surface identity, tenant, logical operation identity and any approved delegated authorization envelope. Consumers re-evaluate current policy/restrictions at execution; pinned workflow code is not a permanent authorization grant. Durable system tasks use explicit service authority when appropriate.

Scoped caches include a surface/authorization-context fingerprint, tenant and relevant purpose, plus data freshness. Authorization decision caches separately include policy/grant versions, relevant attribute versions and expiry. Per-user results must not be shared on `purpose` alone. Cross-purpose cache reuse is allowed only when equivalence of the effective surface/scope is explicitly established by the planner.

## 9. Governed query/mutation enforcement

### 9.1 One secured operation pipeline

```text
Ingress authentication / verified caller
 -> bind trusted invocation and accepted purpose
 -> check exposure and required capabilities
 -> gather permitted policy attributes
 -> derive authorized query or candidate mutation
 -> Gatekeeper / local authorizer decision
 -> enforce obligations + scope + field projection
 -> execute guarded storage plan
 -> validate minimized result / stage controlled egress
 -> privacy-aware audit and telemetry
```

Validation and authorization errors must not disclose hidden record existence or forbidden field values. Define not-found/denied treatment per exposed interface. Errors returned to operators may include richer evidence only through a separately authorized diagnostics action.

For mutations, authorize both current and candidate state where policy depends on ownership, assignment or sensitivity. Guard the revisions of policy-relevant local state. For external PIPs, declare freshness and bounded TOCTOU semantics; a cached HR attribute cannot be atomically locked together with a local database transaction.

### 9.2 Policy filtering

OPA supports data filtering/partial evaluation, but Forge must support a **verified typed subset** for translating policy predicates into SQL or Dynamo query restrictions. [R16] Do not compile arbitrary Rego by string inspection, accept arbitrary SQL from a PDP, or assume matching sample decisions proves equivalence.

A filter plan declares `exact`, `candidate-with-residual-check`, or `unsupported`. Exact pushdown requires soundness/completeness tests against the policy evaluator. Candidate mode needs bounded work, per-record checks, opaque cursors, and explicit pagination/count behavior. Unsupported unbounded filtering is a compile/deploy error, not a hidden scan or post-page leak.

Policy monotonicity changes and unknown built-ins are review findings. Policy query plans include their policy/surface digest so stale plans cannot be combined with new bundles.

### 9.3 Read minimization in each backend

For SQL, select only app-visible fields plus explicitly segregated evaluator/internal fields. For Dynamo, select returned attributes where supported and/or purpose-specific access projections when justified. Any extra stored copies inherit classification, retention and migration obligations. Do not claim fewer read-capacity units merely because fields are omitted.

Trusted invariant validation can still need hidden old fields. Keep these in internal runtime types that are unavailable to generated application capabilities. Idempotency receipts and audit diffs must not re-expose a formerly permitted full result after the caller's current authority narrows.

### 9.4 Managed versus uncontrolled paths

The guarantee applies to generated or verified service paths and controlled egress. Raw DB clients, custom network requests, arbitrary logging, user-supplied serializers, and unconstrained plugins are escape hatches. Mark affected functions/edges as `unverified`, enforce import restrictions where practical, and report which conformance claims no longer apply.

Do not market `uses` or Effect's type system as an isolation boundary against malicious code. Strict workloads require infrastructure isolation and secrets/capabilities scoped to that boundary.

## 10. Authentication, Gatekeeper, PIPs, and delegation

### 10.1 Authentication adapters

Define a normalized principal contract and trusted context entrypoints for HTTP/MCP, RPC, queues, schedules and workflow re-entry. Start with generic OIDC/JWT verification and workload identity adapters; add Better Auth, Cloudflare Access, Cognito, Shoo or other presets only as tested mappings over that contract.

Verify issuer, expected audience, allowed algorithms, signature/key rotation, expiry/not-before and deployment identity mapping. The accepted issuer/audience comes from trusted configuration, never an arbitrary Host/Origin string from the request. Origin-bound providers need explicit authorized-origin mapping. Separate cryptographic token validity from tenant enrollment and action authorization.

MCP authentication follows the negotiated protocol's authorization requirements. Do not forward an incoming bearer token unchanged to an unrelated downstream API or conflate client-provided tool arguments with trusted identity. [R21]

### 10.2 Authorizer boundary

Forge generates actions and maximum surfaces. Gatekeeper owns policy lifecycle, PIP composition, delegated-actor rules, grant enforcement, rate/approval obligations and decision explanation. Gatekeeper remains independently usable with OpenAPI/MCPProvider catalogs; Forge remains independently usable with local policy bundles or another conforming authorizer.

Use a canonical request with:

```text
principal and immediate actor/workload
caller capability + attestation assurance level
callee action, contract/surface/implementation references
root/effective purpose and approved transition
resource scope / requested fields / current and candidate revision
PIP values + issuer/version/observedAt/expiresAt
policy/grant/tenant restriction epochs
request identity, deadline and obligation context
```

Return a typed decision with allow/deny/error, opaque decision ID, permitted plan constraints, required obligations, expiry and evidence references. There is no generic unchecked `obligations: JSON` escape hatch. An unimplemented mandatory obligation fails closed.

### 10.3 PIPs and decision execution

PIP configuration is organization-level and imported by services. Version schemas for trusted attributes, field ownership, missing/error states, privacy classification and cache freshness. Compile required attributes from policy metadata; undeclared/missing providers block strict profiles.

OPA evaluates pure structured inputs. Attribute retrieval remains Effect/PIP work outside evaluation. A local/WASM policy mode must publish supported built-ins and limits; remote-only/network-dependent evaluation cannot be mislabeled offline. Signed OPA bundles are useful distribution artifacts, but documented bundle verification does not itself enforce freshness or meaning of all metadata claims. Forge/Gatekeeper adds explicit expiry, sequence/epoch and trust policy. [R17]

### 10.4 Delegation and function-level assurance

Differentiate original subject, immediate actor, workload, delegated authority and execution function. RFC 8693 supplies a useful subject/actor token-exchange model; adopting it still requires trusted issuers, audience restriction and policy-defined attenuation. [R18]

Publish two assurance profiles:

- **Workload-bound:** the callee authenticates the service workload and trusts its generated dispatcher to identify the function. Compromise of that workload can impersonate a sibling function; the profile says so.
- **Isolated callable:** a trusted gateway or separately isolated workload has an attested entrypoint/credential boundary for the function or approved capability group. The planner proves which isolation mechanism supplies that assurance.

Never sign arbitrary `callerFunction` values using a key available to every function and describe that as cryptographic function isolation. Contract digest attestation must be bound to the executable artifact and deployment identity, not just published `.forge` text.

### 10.5 Freshness, revocation and outage behavior

Signed local policy/grant snapshots keep the registry off the request path. Each has sequence, issuer, audience, contract/surface dependencies, expiry and revocation epoch. Persist high-water marks to prevent rollback to an older valid snapshot.

Declare bounded last-known-good use for low-risk operations. High-risk/restricted operations can require current revocation evidence; fail closed when it cannot be obtained within the declared bound. Availability during partitions and instantaneous global revocation cannot both be guaranteed. Report the chosen bound in the deployment evidence.

Recheck before committed mutations, external disclosure, long-running export chunks and workflow effects. UI tool discovery never substitutes for invocation checks. Reusing an idempotency receipt must reauthorize access to its stored result even though the business effect is not repeated.

## 11. Registry, catalog, discovery and deployment inventory

### 11.1 One artifact source, derived catalogs

A registry contains immutable contract artifacts; its catalog is a rebuildable index over those artifacts, not a second handwritten inventory. Use an existing OCI-compatible registry before implementing an artifact server. OCI distribution is content-type-agnostic and supports digest-addressed manifests/blobs. [R24]

Publish source/IR and audience-specific descriptors with hashes and provenance. Private/internal fields, policy-sensitive topology and examples remain in access-controlled package variants. Do not publish actual tenant records, credentials, subject-rights request contents, secret-derived hashes, or external access tokens.

Catalog indexing still requires code: ingestion, identity resolution, version handling, authorization, indexing, de-indexing, federation, and freshness. It is derived cheaply from the model, not literally zero work.

### 11.2 Distinguish authoritative facts

| Catalog fact | Authority |
|---|---|
| Resource, action, taxonomy and declared `uses` edge | Signed contract package and its publisher trust root. |
| Callee-approved dependency grant | Protected callee repository + verified approval/publication process. |
| Deployed implementation/binding | Deployment controller's attested descriptor. |
| Current health / observed calls | Timestamped runtime/platform observations with known coverage. |
| Principal/policy/consent status | Trusted authorizer/PIPs and subject-rights stores. |

A package version is not a deployment. A published action may have no running endpoint. A dependency graph can contain declared edges that are not approved, deployed or observed.

### 11.3 Registry APIs

Provide versioned APIs for publish/pull by digest, package metadata, action/schema lookup, symbol search, impact traversal, semantic history, deployment announcements, grant-request status and catalog snapshots. Publishing requires namespace ownership. Tags may change; lockfiles resolve immutable content digests.

Snapshot records are tenant/org scoped and include trust root, indexed artifact set, grant set, schema versions, generation and expiry. The catalog can be rebuilt from retained artifacts/events; backups protect nonderived approval and deployment records too.

Offline builds use vendored/pinned artifacts. A runtime boots from its signed permitted snapshots without contacting the catalog, subject to the selected freshness policy. Federation supports private registries and mirrors; it does not merge namespaces or authority based solely on matching strings.

### 11.4 Discovery

Expose an authenticated `/forge/discovery` document for the selected interface, linking concrete operations, schemas, MCP/CLI descriptions and standard OAuth discovery where applicable. `/.well-known/forge` remains experimental/configurable until registered; RFC 8615 defines the well-known suffix registration process. [R23]

A discovery response includes semantic/wire/surface hashes, compatible protocol versions, optional supported features and verified deployment identity. A hash mismatch requires compatibility comparison, not automatic incompatibility. Endpoint URLs are not accepted blindly from untrusted package metadata; bind allowed audiences/origins and defend against SSRF/credential forwarding.

Authorization-sensitive discovery is audience scoped and cache-partitioned. It shows candidate operations but cannot assert permission for every possible record. Include `authorizationRequired`/conditional status instead of promising a tool will always succeed.

## 12. Contractual dependencies and generated approval PRs

### 12.1 Request lifecycle

Adding a new cross-owner `uses` edge creates a **request**, not a grant. CI derives a request artifact from the semantic diff and a verified caller commit. An installed, least-privilege integration opens or updates a PR in the callee repository, with linked status in the caller PR.

```text
declared -> requested -> under-review -> approved-pending-publication
         -> published -> locally-activated -> draining/revoked/expired

rejected and superseded are explicit outcomes
```

The bot's deduplication key includes organization, caller action, callee action, requested purpose and semantic envelope. Repeated CI runs update one request, not open duplicate PRs. Force-push or changed purpose/data effects invalidates stale approval and regenerates the reviewed diff.

### 12.2 Grant artifact

An approved grant binds caller/callee stable actions, caller contract/effect/capability digest, callee supported contract envelope, purposes and allowed transitions, tenant/environment/audience scope, permitted data disclosure surface, delegation/assurance mode, expiry/review conditions, grant epoch, reviewer provenance and source commits.

Semver compatibility alone does not carry authorization forward. A patch with newly disclosed fields or external dependencies needs the review policy applied even when request/response schemas still decode. To avoid reapproving every documentation change, hash the relevant security/effect surface separately from the full package. Actual deploy admission still binds to a signed executable release.

No automatic transitive grants: A→B and B→C does not allow A→C. A compound purpose cannot bypass purpose-specific approval. Caller-owned policy cannot grant authority over a callee-owned action.

### 12.3 Git governance and safe automation

CODEOWNERS can route review, but GitHub documents that any listed owner approval can satisfy code-owner review; listing Payments and Security does not require both. Enforce multi-party requirements explicitly through rules/checks and verify the actual head commit before publication. [R25]

Do not execute untrusted caller code with a cross-repository write token. A privileged bot reads signed/bounded declarative request artifacts, validates repository ownership, constrains paths, and only writes grant files/PR metadata. All generated claims cite source symbols; no model invents a business justification or approval.

### 12.4 Activation and removal

Callee grant merge, signed publication, deployment identity mapping and policy snapshot activation are separate gates. Caller production deployment may require approval before activation while allowing code to merge in a disabled state under configured policy.

Removing a source edge proposes retirement, but an old deployment or pinned workflow may still use it. Drain or explicitly revoke those consumers before cleanup. Emergency revocation is a separate immediate bounded action with its own impact report. Never automatically revoke an edge solely because the newest branch removed it or telemetry saw no recent use.

The Gatekeeper catalog provider imports Forge actions and approved edges into the existing canonical action model. Non-Forge discovery providers remain supported. The Forge Registry is not an obligatory proxy for calls and does not hold all users' downstream credentials.

## 13. Open interfaces, foreign contracts, and clients

### 13.1 One interface projection, not separate authorization universes

Extend the M8 operation descriptors into `InterfaceIR` **after** purpose/capability elaboration. An exposed operation has stable identity, input/output/error schemas, nominal references, invocation mode, idempotency and side-effect declarations, documentation, data classifications, accepted purpose/surface, and transport bindings. HTTP, MCP, CLI and SDK emitters consume that representation.

Exposure is an allowlist, not permission to execute. Discovery returns a caller-appropriate candidate set; resource-specific authorization still occurs on every invocation. Never infer that appearing in `tools/list` grants access to all instances of a resource.

Keep `source` intrinsically one-way, as required by the M8 baseline. HTTP and MCP are interface bindings on callables; WebSocket is a duplex binding with separate input/output types. Surface declarations may live in a reviewed interface manifest rather than introducing another mandatory top-level application noun.

### 13.2 OpenAPI import

Build OpenAPI as the first foreign-contract importer. Pin the supported document versions and feature subset; unsupported features produce diagnostics, not weakened types. OpenAPI supplies operation, parameter, response, schema, security, webhook and callback descriptions, but a document does not prove the remote implementation follows them. [R19]

Implementation work:

1. Resolve local/remote references into an immutable dependency snapshot; limit document size, reference depth, redirects and allowed origins. Never fetch arbitrary schemas from an untrusted service during normal request execution.
2. Normalize schemas while preserving required/optional/nullable distinctions, unions, discriminators, numeric precision, enums, formats and request-versus-response visibility.
3. Preserve globally unique `operationId` values when available. Deterministically synthesize identities from method/path otherwise; explicit overlays supply stable aliases. Do not derive global identity from mutable tags or guess names with an LLM.
4. Model response variants by status and media type, parameter serialization, pagination hints and security alternatives. A machine-readable security scheme creates a binding requirement, not an automatically usable credential.
5. Import callables into `ForeignPackageIR` so normal `uses` resolution works. A missing business-level semantic mapping, such as vendor customer code to Forge Customer identity, remains an explicit implementation slot.
6. Import webhooks/callback contracts without assuming the subscription setup, signature scheme, retries or delivery guarantee. Verify signatures against raw bytes before decoding. Callback URL registration requires SSRF and ownership checks.
7. Support reviewed overlays without mutating the vendor source. Lock original and overlay digests. Semantic diff covers upgrades, including newly allowed outbound fields and authentication changes.

Implementing an imported API is a separate direction: bind each external operation to an internal callable only when request/response mappings are checked. Do not guess conventional CRUD mappings from similar operation names.

### 13.3 RPC realization

A generated callable client wraps either a local Effect implementation, Cloudflare service binding, Lambda invocation, or HTTP. The same invocation context, deadline, idempotency identifier, modeled errors and invocation-failure taxonomy apply. Local calls still pass the appropriate operation boundary; remote network failures remain distinguishable from business errors.

Start with unary calls. Streaming, resumable streams and bidirectional RPC require separate capability profiles with explicit cancellation, backpressure, ordering and transport behavior. Do not expose unsupported streams as unary arrays merely to make a plan compile.

Imported callables never bring implicit credentials or grant transitive authority. A compatible wire schema is necessary but insufficient for trusted remote binding: expected deployment identity, audience, contract/grant envelope and transport security are checked separately.

### 13.4 MCP

Generate typed tools from the approved interface surface. Map read-only/destructive/idempotent annotations conservatively; they remain hints, not enforcement. The MCP specification defines schemas and tool annotations, including their trust limitations. Pin an actual protocol/SDK support matrix instead of assuming every client supports the same extensions. [R20]

Expose authorized schema/resource views as MCP resources where useful; use tools for parameterized queries, mutations and jobs. Never make a Forge record's full storage representation an MCP resource by default. Keep blob metadata and content access separate and enforce size/content limits.

Long-running work exposes portable application jobs (`start`, `status`, `cancel`). Map to negotiated task features only where implemented and tested. Cancellation does not undo committed effects.

Implement discovery and calls under the correct identity, purpose and policy version. Caches and pagination tokens are partitioned accordingly. Recheck authorization on calls even after a successful discovery response. Follow the selected MCP authorization profile; do not pass an arbitrary upstream access token through to unrelated services. [R21]

Test HTTP transport behavior on both Workers and Lambda ingress, including timeouts and response streaming requirements. A protocol feature unsupported by one gateway is not silently certified by the server library alone.

### 13.5 API CLI

Ship one generic client-side CLI engine plus optional branded wrappers. It calls the API; it does not receive database credentials or bypass the mutation engine.

Required behavior includes stable commands derived from operation IDs, schema-aware flags, canonical JSON/file/stdin input, paging, guarded updates, change previews, imports/exports, job status and schema/lifecycle introspection. Use an unambiguous `--input-json` flag for input and `--output json` for output; stdout contains only the selected data format, diagnostics go to stderr, and exit codes are stable.

Semantic convenience parsing may accept explicit units or formatted money and then serialize canonical values. It must not guess locale or mutate API semantics. `--yes` can suppress an interactive prompt but cannot bypass server approval, a stale revision or a purpose restriction.

Use an OS credential store where available, bounded local discovery caches, secure output-file permissions and safe redirect handling. Avoid access tokens in shell command arguments and logs. A user may request a purpose only from the interface's accepted set; the server verifies the right to enter that purpose.

### 13.6 SDKs and standards export

Emit OpenAPI and Smithy from the same minimized `InterfaceIR`. Forge-specific classifications, purpose and capability metadata can accompany the wire model as extensions/traits, but third-party generators are not assumed to enforce them. Server enforcement remains authoritative. Smithy provides service modeling and a code-generation ecosystem; support must be certified for specific generator/language/protocol tuples. [R22]

First certify a plain TypeScript client without an Effect dependency, Python and Go. Add Java and Rust as additional tested tuples. Do not claim every language or every generator is supported automatically.

Cross-language tests must cover exact money/decimal serialization, references, timestamps, PATCH omission versus null, enum unknown-value behavior, typed errors, cursors, idempotency keys, workflow jobs and purpose-specific output shapes. Adding an output enum member can break exhaustive consumers even though it is syntactically additive.

## 14. Semantic diffs, deployment plans, and migrations

### 14.1 Semantic diff extends, rather than replaces, M8 compatibility

Compile both revisions with pinned dependency/toolchain inputs and compare normalized models. Support Git refs, published artifact digests and recorded deployed contracts. Diffing source must not execute untrusted package code or perform privileged deployment operations.

Keep independent dimensions:

| Dimension | Examples |
|---|---|
| Data and wire contract | Required field, enum wire value, codec, reference identity, error shape. |
| Capability/purpose | Added readable field, denied action removed, purpose transition, expanded relationship. |
| Classification/lineage | Sensitive field added, subject mapping changed, newly declared external disclosure. |
| Authority | New dependency grant, changed audience, delegated scope, privilege assurance. |
| Physical plan | SQL index, Dynamo access family, queue fan-out, runtime partitioning. |
| Operation | SLO threshold, durability requirement, schedule, workflow graph. |
| Evidence | Lost telemetry coverage, unmodeled function, unverified provider claim. |

Source compatibility, producer-to-consumer compatibility, security equivalence and data migration are different predicates. Report `compatible`, `breaking`, `review-required` or `unknown` with reasons and evidence. An arbitrary Rego change cannot always be classified as widening or narrowing; say so rather than guessing.

No live row counts in a pure diff. A deployment preflight can attach counts from an explicitly authorized scan, with environment, timestamp and completeness. Generated PR descriptions distinguish verified facts from author-written business rationale. A new status transition does not prove a business outcome improved.

### 14.2 Business and engineering reports

Produce stable JSON first, then deterministic human views. Business reports emphasize field meanings, newly available actions, changed privacy purposes and operational procedures. Engineering reports include schema/backfill plans, policy/ABI compatibility, derived-state rebuilds, protocol changes and affected dependency edges.

Generated changelogs and semver suggestions are advisories backed by compatibility rules. Explicit approvals and justified exceptions are signed against exact artifact digests. Documentation-only changes need not invalidate security grants; data/side-effect/purpose changes can require reapproval even without a wire-schema change.

### 14.3 Rollout DAG

Build a resumable deployment DAG that composes the existing M8 migration runner with governance changes:

```text
Verify baseline and trust
 -> provision additive infrastructure
 -> install compatible schema/readers/writers
 -> publish contracts without granting execution
 -> obtain/verify grants and policy snapshots
 -> run backfills, subject indexes and projection rebuilds
 -> validate data, authority and rollout invariants
 -> shift traffic / enable new operations
 -> observe release gates
 -> drain old workflows, messages and consumers
 -> contract old storage/interfaces/grants in a later phase
```

Not every release needs all stages. For each node record idempotency identity, dependencies, execution lease/fencing, preconditions, output digest, compensation/recovery policy and completion evidence. Do not promise a cross-provider atomic deployment.

Cloudflare gradual deployments can run versions against shared state, which is why compatibility must cover both versions during rollout. [R26] The same Forge requirement applies to AWS/container strategies even when traffic mechanisms differ.

SLO gates need minimum sample/traffic and telemetry-completeness requirements. Low traffic or missing metrics produces `insufficient evidence`, not an automatic success. A five-minute sample does not establish compliance with a 28-day objective.

### 14.4 Security-aware migration rules

Adding a purpose surface is not just codegen. Update API/client shapes, physical query projections, cached entries, idempotency-result visibility, export templates, telemetry allowlists and authorized dependency manifests. A narrower surface must not continue serving a prior full-record cache or stored receipt.

A changed classification may require data discovery, re-encryption, cache purging, altered retention and review of copies. Do not assume changing a label retroactively changes all historical data handling.

Keep workflow **code/graph** versions pinned, but apply current revocation and subject restrictions at protected steps. Old grants may need to remain during planned drain; emergency revocation can interrupt them explicitly. Never restore revoked authority automatically when rolling application code back.

Only one authority applies a physical migration stream. Alchemy, Drizzle Kit, Forge and Terraform must not independently mutate the same schema history. Long backfills run as durable jobs, not synchronous IaC provisioner callbacks. Switching IaC tools requires a reviewed state/ownership handoff.

### 14.5 Provider/database cutover

Recompiling for PostgreSQL does not move D1/Dynamo data. Retain M8's canonical export/import path, with a first certified cutover using a write fence. Preserve identities, versions, subject relations and idempotency semantics; transfer verified blobs, reconcile outbox delivery, rebuild derived state and verify canonical checksums/invariants before enabling writes.

Native workflow history is not generically portable. Drain, retain execution on the old provider, or use a separately designed portable checkpoint migration. Active browser sockets and opaque pagination cursors may require reconnect/restart under documented errors.

Restore procedures load a current protected deletion/restriction ledger before making restored records available. The ledger must survive a database restore; keeping the only copy inside the restored snapshot cannot prevent resurrection.

## 15. Governance operations, subject rights, and compliance evidence

### 15.1 Requirements and limits

Classification, context and purpose let Forge evaluate **specified technical controls**. They do not decide legal applicability or prove a person's real intention. GDPR purpose limitation, legal grounds and erasure exceptions require contextual assessment; pseudonymized linkable data is not automatically anonymous. [R13]

Regulatory packs are versioned, reviewed mappings from applicable context into technical/control requirements, with cited legal or standards sources. An education-record profile must evaluate the record and custodian context, not just an email field; child-service profiles need audience/collection facts, not just a birth-date column. [R14][R15]

Use explicit findings: `satisfied-with-evidence`, `violated`, `unknown`, `external-attestation-required`, and `not-applicable-with-rationale`. A static proof claim includes the property, modeled boundary, trusted compiler/runtime assumptions and proof/test evidence. Missing telemetry is not evidence of no violations.

### 15.2 Generated subject-operation plans

Provide privileged `locate`, `export`, `rectify`, `restrict` and `erase` operations for explicitly modeled subjects. These are generated operations/workflows, not automatic public CRUD routes. Verify request authority and applicable disposition before execution.

An erasure plan identifies authoritative rows, all subject associations, copies in access items/projections/cache, finalized blobs and versions, imports/exports, outbox/messages/DLQs, stored workflow inputs/results, audit/receipts, backups and declared external recipients. Include unmodeled/unknown locations rather than hiding them.

A relationship is not an automatic deletion cascade. A guardian's email can belong to several children, an order can have several individuals' information, and a Customer may be an organization. Resolve field/subject-specific dispositions so erasing one subject does not erase another person's legitimate record.

Dispositions include deleting fields/records, rebuilding derived state, invalidating caches, restricting retained records, requesting external action, or retaining specified minimum data under an approved hold. Pseudonymization and tokenization remain transformations with residual linkability, not blanket erasure success.

### 15.3 Durable execution and prevention of resurrection

Track request verification, plan approval, legal/organizational holds, execution, external acknowledgments, verification and unresolved obligations. A remote provider acknowledging an erasure request is not evidence that its data has been erased.

Use deletion/restriction epochs or suppression records so old queue messages, delayed imports, cache rebuilds, restored backups and retried workflows cannot recreate erased data. Authenticate and minimize the suppression ledger; it is itself potentially personal data. Define a justified retention and access policy for it.

Gate chunked exports and long jobs against current authority/restrictions. Revalidate before releasing a download URL; capability-bearing URLs cannot generally be revoked after issuance unless the provider supports it. The exposure interval must be explicit.

### 15.4 Recovery and cryptographic capabilities

State requirements describe confidentiality, integrity, availability, retention/residency and recovery objectives with an explicit failure model. An RPO/RTO requirement is not satisfied just because a backup option is enabled. Validate configuration, backup success, restore drills and measured recovery evidence.

Key services expose `encrypt`, `decrypt`, `sign` or `verify` capabilities without necessarily exporting private key material. Bind keys through deployment capabilities, not `.forge` values. Key rotation, backup encryption and retention need documented ownership. Crypto-erasure is only claimed under a verified key-isolation/copy model; it does not erase plaintext already disclosed elsewhere.

## 16. Observability, dashboards, and evidence

### 16.1 Extend M8 logical instrumentation

Keep M8 operation identities and SLO semantics. Add bounded attributes for purpose/surface, policy/grant revision, decision class, classified-flow coverage and dependency authorization assurance. Sensitive names, subject IDs and raw field values are not default labels. Some purpose names reveal sensitive context; telemetry publication is itself an authorized disclosure.

Generated operations record their declared and enforced surface, not their full inputs/outputs. Custom code receives safe structured logging APIs; raw logging/network escapes downgrade coverage and require explicit review. Do not claim the compiler can guarantee what arbitrary `console.log` or HTTP code emits.

Keep authority records separate from trace propagation. Trace IDs help join evidence; they do not authenticate a call. Async fan-in and long-lived workflows use links/correlation where appropriate rather than forcing every activity into one enormous span tree.

### 16.2 Dashboard generation

Extend `ObservabilityIR` with logical panel/query templates: function/CRUD SLIs, authorization denials and decision latency, dependency edges, policy-snapshot freshness, grant activation lag, outbox/backlog/duplicates, workflow deadlines, cache freshness, projection lag, privacy-job status and restore evidence.

Start with one tested Grafana/Prometheus-compatible dashboard/rule emitter and links into the selected tracing backend. Do not create a new metrics database. When a provider cannot supply a metric, display an unsupported/missing-data panel or omit it with a capability diagnostic; never display an invented zero.

Native Workers OTLP export currently documents traces/logs rather than custom metrics. Retain a separately tested metric exporter/collector path on Cloudflare and verify counts/export gaps on all profiles. [R27]

### 16.3 Runtime evidence is bounded

For important claims, record coverage and freshness, not just a pass/fail badge. A deployment evidence bundle includes contract/security/executable digests, target capability manifests, dependency lock, policy/grant snapshots, migration results, conformance results, telemetry window/completeness and external attestations.

Use OSCAL as an optional export for implementation/assessment evidence, not as the internal application model and not as an automatic compliance certificate. OSCAL's purpose is machine-readable security-control and assessment information. [R28]

The registry indexes references and summaries; confidential audit logs and personal data stay in separately authorized evidence storage. Signed evidence is tamper-evident provenance, not proof the underlying asserted fact is correct.

## 17. Reference applications and demonstration contracts

### 17.1 Acme remains the primary reference application

Extend rather than replace the original Customer/Site/SitePolicy/Order/Attachment/Workflow/Channel example. Acme is the tenant organization; Customer is a business customer. Add `Contact` as a person-subject resource so privacy modeling does not confuse a company with a natural person.

The next reference app includes:

- CustomerSupport, OrderFulfillment and PaymentProcessing purposes, plus a separately authorized Marketing purpose with no implicit access to support data.
- Contact capability fragments for identity, contact details and restricted support notes; a narrower agent-support surface.
- Customer/Site/Order operations under named surfaces, with relationship traversal and query authority checked separately.
- Imported Payments callables and messages, one callee-owned dependency grant and a purpose transition with explicit scope.
- Existing import/blob/cache/view/projection functionality with new classification and subject lineage, not a parallel privacy-only storage model.
- HTTP, MCP, CLI and at least two non-Effect SDK clients operating over the same interfaces.
- Registry publication and a mocked/real-test-repository approval integration, then Gatekeeper local snapshots and revocation tests.

### 17.2 One business scenario spans all layers

An operations agent under CustomerSupport reads permitted Contact details but cannot read support notes, export contacts, filter by a hidden field or dereference a hidden relation. A human with the broader support capability can perform the permitted support operation after assignment checks.

A developer adds a payment dependency under PaymentProcessing. Semantic diff explains the new action and classified disclosure. The bot opens a callee approval PR; execution remains disabled until a reviewed grant and correct deployed identity are activated. A later policy revocation blocks calls within the declared bound even when the registry is offline.

A subject restriction invalidates appropriate cached results and prevents a delayed export/workflow step from disclosing newly restricted data. The changed contract produces business release notes and an engineering dashboard update.

Run these scenarios with identical application implementation and normalized public behavior on D1/Alchemy, Dynamo/CDK and PostgreSQL/Node. Add PostgreSQL-on-Workers and PostgreSQL-on-Lambda profiles after driver/isolation certification. Performance is measured per profile, not expected to match.

### 17.3 Industry fixtures without scope explosion

Include a synthetic education fixture with concrete Student/Guardian subject links and education-record context, and an industrial recipe fixture that is confidential/integrity-critical without being personal data. These verify the facet model's generality. They are not production FERPA/COPPA or industrial-safety templates.

The package's examples are design fixtures. Until a Forge compiler exists for this edition, validation is limited to declared structural/reference checks; do not label these examples compiled.

## 18. Repository, ownership, and artifact contracts

Preserve the existing Rust workspace and grow modules before proliferating packages:

```text
crates/
  forge-syntax/       # grammar, lossless syntax, formatter, diagnostics
  forge-semantic/    # symbols, types, governance, capability algebra
  forge-planner/     # queries/mutations, adapters, secured physical plans
  forge-codegen/     # runtime/interfaces/SDK and dashboard projections
  forge-cli/         # build/check/diff/publish/plan orchestration
packages/
  runtime/           # shared guarded execution and InvocationContext
  contracts/         # versioned IR schemas and generated TS bindings
  adapters/          # storage, drivers, RPC, workflow and infrastructure
  gatekeeper/        # adapter only; Gatekeeper remains independent
  registry/          # artifacts, indexing, snapshots, inventory
  interfaces/        # HTTP/MCP/API CLI/discovery
  governance/        # lineage, subject jobs, control evidence
  testing/           # reference model, fault injection, conformance
specs/
  language/ ir/ portability/ governance/ security/ protocols/
examples/
  acme/ payments/ education-fixture/ industrial-fixture/
```

These are responsibility boundaries, not a requirement to publish every directory as a separate npm crate/package immediately.

Assign accountable owners by workstream: compiler/language, runtime/transactions, storage/provider, identity/Gatekeeper, registry/release automation, and SDK/tooling. Security-sensitive changes to capability algebra, identity, grant activation and subject erasure require independent review. Do not assume a single engineer's approval in a shared ownership file provides separation of duties.

### Artifact boundaries

| Artifact | Contents | Authority |
|---|---|---|
| Contract package | Source, public IR, provenance, interface/governance digests | Package owner and verified build. |
| Capability surface | Flattened fields/actions/queries plus retained denials | Deterministic compiler output. |
| Deployment release | Executable, bindings references, exact contract and policy requirements | Deployment owner. |
| Approved grant | Caller/callee/purpose/data/assurance envelope and approval evidence | Callee owner; activated by policy controller. |
| Registry catalog | Derived search/dependency index and version history | Rebuildable index, not independent semantic truth. |
| Runtime snapshot | Approved action/grant/policy state with expiry and epoch | Trusted reconciler. |
| Migration history | Reviewed immutable migration intents and physical steps | One configured migration authority. |
| Evidence bundle | Results, coverage, timestamps, signatures, source links | Assessed claim with explicit evidence provenance. |

All public formats are versioned and bounded. Unknown critical fields/features are rejected; unknown noncritical extensions are preserved or explicitly ignored by format rules. Extension code is never implicitly executed because a dependency includes a new decorator or data class.

## 19. Post-M8 milestones and implementation tickets

Milestones are dependency ordered, not calendar estimates. Independent tasks may run in parallel once their input contracts are frozen. IDs continue the original backlog. Owner labels are engineering responsibilities, not named staffing assumptions.

| Milestone | Focus | Depends on | Tickets |
|---|---|---|---|
| M9 | Baseline capture, edition and extension contracts | M8 evidence inventory | FORGE-027–FORGE-031 |
| M10 | Composable adapters, PostgreSQL and Node | M9 | FORGE-032–FORGE-036 |
| M11 | Data taxonomy, subject bindings and lineage | M9 | FORGE-037–FORGE-041 |
| M12 | Purpose and composable capability compiler | M11 | FORGE-042–FORGE-046 |
| M13 | Invocation identity, Gatekeeper and runtime enforcement | M10, M12 | FORGE-047–FORGE-051 |
| M14 | OpenAPI, RPC, MCP, API CLI and SDK interfaces | M13 | FORGE-052–FORGE-056 |
| M15 | Registry, derived catalog and deployment inventory | M14 | FORGE-057–FORGE-061 |
| M16 | Callee-owned dependency grants and approval PRs | M15, M13 | FORGE-062–FORGE-066 |
| M17 | Semantic diff, governance migration and rollout control | M16, M10 | FORGE-067–FORGE-071 |
| M18 | Managed providers and deployment portability packs | M17 | FORGE-072–FORGE-076 |
| M19 | Subject rights, retention and recovery evidence | M17, M11, M13 | FORGE-077–FORGE-081 |
| M20 | Generated dashboards, privacy-safe telemetry and evidence | M18, M19, M16, M14 | FORGE-082–FORGE-086 |
| M21 | Cross-profile certification and governed release | M20 | FORGE-087–FORGE-091 |

### M9 — Baseline capture, edition and extension contracts

**Objective:** Establish a measured M8 baseline and stable semantic extension boundaries.

**Predecessors:** M8 baseline; unverified M8 gates remain blockers.

**FORGE-027 — Capture actual M8 completion and regression artifacts** (runtime/testing). Import the original 26 tasks and 75 scenarios unchanged. Inventory compiler/runtime versions, wire goldens, migrations, deployments and missing gates.

Acceptance: A machine-readable baseline distinguishes passed evidence from pending specifications; no missing gate is silently declared complete. Primary deliverable: `specs/m8-baseline.json`.

**FORGE-028 — Freeze the next language edition and compatibility rules** (compiler). Ratify source-versus-binding, nominal references, explicit enums, lifecycle-derived states, purpose semantics, per-verb field authority and stable symbol identity.

Acceptance: Formatter/parser fixtures cover old and new editions; file moves and display-label changes preserve identity. Primary deliverable: `specs/language/next-edition.md`.

**FORGE-029 — Version IRs and separate semantic hashes** (compiler). Add governance/interface/adapter schemas and distinct wire, documentation, security-effect and executable provenance hashes. Implement up-conversion of supported old IRs.

Acceptance: A documentation edit does not change the security digest; an added classified output field does. Unknown critical IR features fail closed. Primary deliverable: `specs/ir/next/`.

**FORGE-030 — Define extension loading and deterministic capability manifests** (compiler/platform). Keep compilation offline. Validate pinned adapter/taxonomy/importer metadata, bounds and feature support without executing arbitrary package code.

Acceptance: Repeated builds match under shuffled discovery order; malformed/untrusted extensions cannot run code or silently relax requirements. Primary deliverable: `packages/contracts/capability-manifest`.

**FORGE-031 — Write threat model and reference semantic assertions** (security/testing). Define trusted computing base, function-identity assurance, raw escapes, subject linkage, purpose attenuation and registry outage boundaries.

Acceptance: Each claimed property identifies enforcement point, assumptions, evidence, and a negative scenario. Primary deliverable: `specs/security/threat-model.md`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M10 — Composable adapters, PostgreSQL and Node

**Objective:** Break the provider/runtime/deployment coupling without breaking M8 semantics.

**Predecessors:** M9

**FORGE-032 — Refactor existing target packs behind adapter interfaces** (runtime/platform). Separate engine, provider, connection, query facade, compute, workflow, messaging and IaC choices. Preserve backward-compatible D1/Alchemy and Dynamo/CDK entrypoints.

Acceptance: The original client/goldens and all applicable M8 tests remain unchanged after refactor. Primary deliverable: `packages/adapters/core`.

**FORGE-033 — Implement PostgreSQL relational planning and mutation execution** (storage). Lower canonical fields, keys, constraints, guarded transactions, audit/outbox and conditional revision checks to PostgreSQL; preserve portable sorting and numeric semantics.

Acceptance: Concurrent uniqueness, reference delete races and lost-response retries satisfy the same invariants as D1 and Dynamo. Primary deliverable: `packages/adapters/postgres`.

**FORGE-034 — Certify Effect SQL and Drizzle connection modes** (storage/runtime). Add shared SQL plans with both facades, driver feature manifests, RLS role separation, transaction-local scope reset and no-cache authorization queries.

Acceptance: Pooled connections cannot retain prior tenant context; unsupported interactive transactions are rejected rather than emulated unsafely. Primary deliverable: `packages/adapters/sql-facades`.

**FORGE-035 — Implement production Node host and local service composition** (runtime). Add Fetch-compatible ingress, background lifecycle, graceful shutdown, bounded concurrency, health probes and durable worker recovery. Reuse contracts and implementation modules.

Acceptance: A restart does not lose acknowledged jobs or leak invocation context; ordinary CRUD runs with Node and PostgreSQL. Primary deliverable: `packages/adapters/node`.

**FORGE-036 — Certify PostgreSQL runtime profiles and adapter selection** (platform/testing). Run PostgreSQL with Node, then Workers and Lambda through explicit tested connection modes. Emit support/evidence matrices and cost/limit diagnostics.

Acceptance: Declared transaction, read and freshness guarantees pass or produce unsupported diagnostics for each exact driver profile. Primary deliverable: `conformance/profiles/postgres`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M11 — Data taxonomy, subject bindings and lineage

**Objective:** Make data meaning and coverage precise without hardcoding industry or legal policy.

**Predecessors:** M9

**FORGE-037 — Implement faceted DataSemanticsIR and taxonomy packages** (compiler/governance). Add semantic-kind DAGs, origin, subject roles, record context, handling policy, transformations and evidence provenance; support namespaced optional domain packs.

Acceptance: Unknown custom classifications remain conservative; multi-label inheritance preserves ancestors and cannot lower handling obligations implicitly. Primary deliverable: `crates/forge-semantic/governance`.

**FORGE-038 — Implement concrete subject binding and subject indexes** (runtime/governance). Resolve subject references through fields/relations, including multiple subjects per record and organization-versus-person distinctions. Maintain indexes transactionally where required.

Acceptance: A guardian/shared record fixture locates each subject correctly without treating Customer organization identity as person identity. Primary deliverable: `packages/governance/subjects`.

**FORGE-039 — Compile generated-operation data flow and conservative custom effects** (compiler). Track reads, writes, conditions, ordering, group membership, derived values and external sinks across operations and shapes. Require explicit summaries or mark custom flows unknown.

Acceptance: Filtering on a hidden classified field remains a classified processing edge; raw SDK effects are not reported as fully modeled. Primary deliverable: `crates/forge-semantic/lineage`.

**FORGE-040 — Add classification evidence and unstructured-data inspection hooks** (runtime/governance). Separate declared/type-inferred classification from detector observations; design versioned evidence and quarantine/review behavior for failed inspection.

Acceptance: A detector failure or negative sample cannot relabel a declared-sensitive field as public; no raw scanned content enters the registry. Primary deliverable: `packages/governance/classification-evidence`.

**FORGE-041 — Generate inventories and reviewable taxonomy changes** (tooling/governance). Emit authorized field inventories, lineage reports and synthetic education/industrial fixtures. Show classification and subject changes in machine-readable deltas.

Acceptance: Both personal education data and nonpersonal restricted recipes are represented without conflating confidentiality with PII. Primary deliverable: `docs/data-semantics-and-inventory.md`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M12 — Purpose and composable capability compiler

**Objective:** Compile explicit business purpose into concrete maximum field/action surfaces.

**Predecessors:** M11

**FORGE-042 — Implement purpose declarations and explicit transitions** (compiler). Add stable purpose IDs, taxonomy relationships and explicit dependency purpose changes. Separate purpose taxonomy from authorization inheritance.

Acceptance: Child/composite purposes gain no permissions merely from extends/includes; undeclared purpose transitions fail. Primary deliverable: `crates/forge-semantic/purposes`.

**FORGE-043 — Implement capability inclusion and sticky-deny algebra** (compiler/security). Implement resource-local fragments, per-verb fields, named actions, includes, deny closure and cycle/collision diagnostics; flatten deterministically.

Acceptance: Property tests establish order independence, idempotence, deny preservation and runtime attenuation. Primary deliverable: `crates/forge-semantic/capabilities`.

**FORGE-044 — Generate scoped types and distinct Effect service keys** (codegen/runtime). Emit concrete Resource.Record<Purpose> schemas and nominal requirement services. Reject unscoped results and generic mutable state leakage.

Acceptance: A scoped reader has neither forbidden properties nor forbidden methods; serializing its result cannot reveal extra object keys. Primary deliverable: `packages/contracts/scoped-services`.

**FORGE-045 — Compile scoped query and relationship plans** (compiler/storage). Separate read/filter/order/aggregate/export/expand permissions. Lower approved fields and bounded relationship surfaces into queries for all engines.

Acceptance: A hidden field cannot become a filter/count oracle; reading a reference never grants unrestricted expansion. Primary deliverable: `crates/forge-planner/scoped-query`.

**FORGE-046 — Implement capability explain, migration and test fixtures** (tooling/testing). Add source-linked effective-surface explanations, examples, golden schemas and codemod proposals for old broad readers.

Acceptance: Every generated surface explains its included and denied origin; behavior-preserving changes and widenings are distinguished. Primary deliverable: `docs/purpose-capabilities.md`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M13 — Invocation identity, Gatekeeper and runtime enforcement

**Objective:** Enforce current authority at every protected operation without contaminating portable logic.

**Predecessors:** M10, M12

**FORGE-047 — Implement trusted InvocationContext and authentication adapters** (identity/runtime). Normalize issuer-qualified principals, immediate workload, delegated actor, tenant and accepted purpose at ingress. Support generic OIDC and provider-specific bindings via explicit claim maps.

Acceptance: Spoofed tenant/purpose/caller headers fail; concurrent invocations cannot share user-bearing context or trust arbitrary Origin as audience. Primary deliverable: `packages/runtime/identity`.

**FORGE-048 — Implement Gatekeeper request/decision and PIP contracts** (security). Generate canonical action/surface/effect inputs and typed attribute requirements; add allow/deny/obligation handling and local/remote authorizer adapters.

Acceptance: Missing attributes and unknown mandatory obligations deny; Gatekeeper remains independently usable without Forge registry. Primary deliverable: `packages/gatekeeper/contract`.

**FORGE-049 — Enforce scoped authority in reads, mutations and egress** (runtime/storage). Guard per-row and current/candidate state, enforce local policy revisions inside commit, project output bytes, and reauthorize cached/idempotency results.

Acceptance: A permitted update cannot transfer ownership to an unauthorized scope; a replay after revocation cannot disclose an old broad response. Primary deliverable: `packages/runtime/authorization`.

**FORGE-050 — Implement typed policy filtering and bounded decision caching** (security/storage). Integrate OPA evaluation and a supported typed filtering subset; model residual checks, PIP freshness, current policy epochs and query limits.

Acceptance: Arbitrary untranslatable Rego is rejected or evaluated over a bounded candidate query; no client-selected scope or unbounded scan bypass. Primary deliverable: `packages/gatekeeper/query-planning`.

**FORGE-051 — Implement delegation assurance and revocation behavior** (security/platform). Provide workload-bound and isolated-callable assurance profiles, audience/downscoping checks, signed snapshot refresh, expiry and emergency epoch handling.

Acceptance: A shared process cannot advertise isolated per-function identity; stale/expired authority denies sensitive operations within the configured bound. Primary deliverable: `specs/security/delegation-and-revocation.md`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M14 — OpenAPI, RPC, MCP, API CLI and SDK interfaces

**Objective:** Expose one minimized operation model to humans, agents and non-Effect clients.

**Predecessors:** M13

**FORGE-052 — Implement pinned OpenAPI importer and foreign package normalization** (compiler/tooling). Resolve bounded pinned refs/overlays; import schemas, operation IDs, request/response variants, security slots and webhook/callback contracts with unsupported-feature diagnostics.

Acceptance: Repeated import is deterministic; malicious remote refs/URLs fail; same-looking external IDs are not automatically Forge references. Primary deliverable: `crates/forge-codegen/openapi-import`.

**FORGE-053 — Implement callable transport bindings and unified InterfaceIR** (runtime/codegen). Add local/HTTP/Worker RPC/Lambda adapters over the same unary contracts and purpose/delegation context. Preserve business versus invocation failure classes.

Acceptance: Local and remote invocations enforce the same operation envelope; mismatched contract/audience fails before disclosure. Primary deliverable: `packages/interfaces/rpc`.

**FORGE-054 — Implement authorized MCP tools/resources and discovery** (interfaces/security). Generate per-surface tools, safe resources, bounded blobs and portable job tools; negotiate optional features using a pinned protocol matrix.

Acceptance: Changing identity/purpose cannot reuse another tool/resource listing or response; annotations never bypass authorization. Primary deliverable: `packages/interfaces/mcp`.

**FORGE-055 — Implement API CLI and cross-language client generation** (interfaces). Build generic CLI with canonical JSON/stdin/file modes, stable exit/error behavior, guarded mutations and secure credentials; certify plain TS, Python and Go SDK paths.

Acceptance: CLI/MCP/HTTP return matching scoped values and errors; no client needs Effect or direct database access. Primary deliverable: `packages/interfaces/cli-and-sdks`.

**FORGE-056 — Implement discovery metadata and interface golden conformance** (codegen/testing). Emit bounded authenticated /forge/discovery with contract/features/auth metadata links. Generate Smithy/OpenAPI and validate selected language/protocol toolchains.

Acceptance: Discovery is not deployment trust; hash mismatch triggers compatibility evaluation rather than false equivalence. Undeclared public operations remain hidden. Primary deliverable: `specs/interfaces/conformance.json`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M15 — Registry, derived catalog and deployment inventory

**Objective:** Distribute immutable contracts and index them without becoming the application hot path.

**Predecessors:** M14

**FORGE-057 — Implement immutable OCI-backed publication and resolution** (registry). Publish allowlisted source/IR/interface artifacts with digests/provenance; verify on pull; support offline cache, workspace/path dependencies and trust policies.

Acceptance: Mutable tags cannot substitute for locked digests; an invalid artifact is never executed or activated. Primary deliverable: `packages/registry/artifacts`.

**FORGE-058 — Implement idempotent catalog indexing and search APIs** (registry). Index exports, fields/classes/subjects, purposes, actions, effects, owners and declared dependencies from artifacts; version index schema and rebuild.

Acceptance: Reindexing the same digest is idempotent; catalog loss can be recovered from artifacts without changing package authority. Primary deliverable: `packages/registry/catalog`.

**FORGE-059 — Implement confidential catalog access and federation** (registry/security). Restrict metadata by organization/namespace/audience; define cross-registry identity, mirror trust and search/result filtering.

Acceptance: Sensitive type/purpose names do not leak to unauthorized users; equal package names in different authorities do not collide. Primary deliverable: `packages/registry/security`.

**FORGE-060 — Implement deployment inventory and contract verification** (registry/platform). Accept authenticated deployment descriptors, endpoint identities, current digests and retirement state; distinguish signed reports from observed health.

Acceptance: Publishing a contract does not claim it is deployed; stale inventory is visibly stale; endpoint SSRF checks hold. Primary deliverable: `packages/registry/deployments`.

**FORGE-061 — Implement local catalog/policy snapshot reconciliation** (registry/security). Produce versioned signed incremental snapshots, activation acknowledgments, expiry/revocation epochs and bounded offline behavior.

Acceptance: Registry outage does not add request-time lookup dependency; expired required security state follows the specified deny/degrade rule. Primary deliverable: `packages/registry/snapshots`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M16 — Callee-owned dependency grants and approval PRs

**Objective:** Turn cross-service uses edges into reviewed, activated, purpose-bound privileges.

**Predecessors:** M15, M13

**FORGE-062 — Implement dependency request and grant schemas** (security/registry). Represent caller/callee identity, effects/surface digests, purpose transitions, environment/audience/scope, assurance, lifetime and review provenance.

Acceptance: Contract import alone never creates a grant; semver-compatible security widening can require reapproval. Primary deliverable: `schemas/dependency-grant.schema.json`.

**FORGE-063 — Implement safe idempotent callee-PR automation** (release/security). Read authenticated bounded request artifacts, route to owner repositories, update a restricted grants path and link caller/callee PRs. Do not execute caller code with bot credentials.

Acceptance: Repeated runs create one PR; changed head content invalidates stale approval; repository/path escalation tests fail. Primary deliverable: `packages/registry/approval-bot`.

**FORGE-064 — Implement reviewer requirements and artifact publication** (release/security). Verify protected-branch merge and actual head commit; enforce required owner groups explicitly; publish immutable approved grants.

Acceptance: Payments plus Security approval requires both configured checks, not merely both names on one CODEOWNERS line. Primary deliverable: `packages/registry/grant-publication`.

**FORGE-065 — Implement activation, admission and runtime edge verification** (gatekeeper/platform). Bind approved envelopes to deployed identities, distribute snapshots and enable calls only after activation. Keep declared/approved/observed graphs distinct.

Acceptance: A merged PR without activated grant remains denied; A→B and B→C never authorizes A→C. Primary deliverable: `packages/gatekeeper/grants`.

**FORGE-066 — Implement grant rotation, drain, emergency revoke and reporting** (release/security). Track active releases and workflow use before retirement, enforce emergency epochs, suggest unused-grant review with telemetry coverage, not automatic assumption.

Acceptance: Removing a dependency does not break explicitly draining releases without policy decision; emergency revoke blocks stale grants within its bound. Primary deliverable: `docs/grant-lifecycle.md`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M17 — Semantic diff, governance migration and rollout control

**Objective:** Make source-to-production changes reviewable and resumable across state and authority.

**Predecessors:** M16, M10

**FORGE-067 — Extend semantic diff across governance/interfaces/dependencies** (compiler/tooling). Compare pinned Git/artifact/deployed models, preserving stable IDs and directional compatibility. Emit machine JSON and audience-specific PR/changelog reports.

Acceptance: Whitespace/file moves produce no semantic change; arbitrary policy edits can report unknown; no invented live-row counts. Primary deliverable: `crates/forge-semantic/diff`.

**FORGE-068 — Implement governance-aware migration planning** (compiler/runtime). Plan scoped readers, cached/result surfaces, subject indexes, taxonomy revisions, field transformations, grants and projections alongside storage changes.

Acceptance: Narrowing a purpose invalidates incompatible caches/receipts; unmapped new sensitive fields block unsafe automatic exposure. Primary deliverable: `crates/forge-planner/migrations`.

**FORGE-069 — Implement resumable deployment DAG and durable ledger** (release/platform). Coordinate preflight, expand, compatibility releases, backfill, verification, traffic, drain and later contract using leases/fencing and artifact-bound approval.

Acceptance: Crash/retry resumes without duplicate backfill or grant activation; stale deploy controller cannot continue after losing its lease. Primary deliverable: `packages/runtime/deployment-ledger`.

**FORGE-070 — Implement data/IaC ownership transfer and rollback safeguards** (platform/storage). Extend canonical export/import, blob verification, write-fenced cutover, restore suppression and explicit IaC-state handoff; keep native workflows on supported drain/checkpoint path.

Acceptance: No automatic database deletion or workflow-history translation; rollback cannot revive revoked grants or erased subjects. Primary deliverable: `docs/provider-cutover.md`.

**FORGE-071 — Implement governed previews and staged release gates** (release/testing). Create isolated/sanitized preview profiles, minimum-data SLO gates, signed acknowledgments and cleanup policies with default retain.

Acceptance: Missing metrics do not pass promotion; preview data cannot bypass production classification/retention through database branching. Primary deliverable: `packages/adapters/release-gates`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M18 — Managed providers and deployment portability packs

**Objective:** Certify additional combinations rather than announcing universal matrix support.

**Predecessors:** M17

**FORGE-072 — Implement attach-existing Neon and PlanetScale Postgres profiles** (storage/platform). Bind exact managed PostgreSQL products through supported connection modes with transaction/cache/role/backup descriptors. Add optional provisioning separately.

Acceptance: The Postgres contract suite passes on each exact profile or capability status remains unverified. Primary deliverable: `packages/adapters/managed-postgres`.

**FORGE-073 — Implement and qualify Turso profile** (storage). Pin the chosen engine/client/dialect, test transaction/assertion/foreign-key/ordering behavior and define gaps relative to SQLite/D1 without name-based assumptions.

Acceptance: Unsupported mutation guarantees reject the profile; no unverified SQLite-equivalence claim. Primary deliverable: `packages/adapters/turso`.

**FORGE-074 — Implement Terraform physical-plan emitter** (deployment). Emit pinned provider-specific .tf.json from resolved deployment plans with secret references, adoption rules and separate migration jobs.

Acceptance: terraform validate passes for supported profiles; produced resources satisfy the same resolved plan as native IaC adapters. Primary deliverable: `packages/adapters/terraform`.

**FORGE-075 — Implement Docker and Nix self-hosted packaging** (deployment). Build reproducible Node artifacts, nonroot containers, Compose topology, Nix package/NixOS units, health/shutdown and external secret injection.

Acceptance: No secret enters image layers/Nix store; clean installation and upgrade/rollback follow the same application migration ledger. Primary deliverable: `packages/adapters/self-hosted`.

**FORGE-076 — Implement full self-hosted workflow/messaging profile** (runtime/platform). Use Temporal as the initial production workflow realization and certified durable messaging/object storage adapters; retain a simple CRUD-only Node/Postgres profile.

Acceptance: Full Acme tests survive restart, early signals and outbox retries on the self-hosted profile; Compose alone is not claimed to supply a workflow engine. Primary deliverable: `conformance/profiles/self-hosted-full`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M19 — Subject rights, retention and recovery evidence

**Objective:** Generate bounded, auditable governance operations over declared data flows.

**Predecessors:** M17, M11, M13

**FORGE-077 — Implement subject inventory and reviewed disposition planning** (governance). Locate concrete subject data and copies, evaluate configured holds/retention/disclosure requirements and produce a reviewable plan with unknowns.

Acceptance: Multi-subject records preserve other subjects; unknown lineage/external destinations prevent an unqualified complete verdict. Primary deliverable: `packages/governance/rights-planner`.

**FORGE-078 — Implement durable erasure/restriction/export workflows** (governance/runtime). Use existing workflow engine for authenticated approved plans, chunked reauthorization, source records, blobs, indexes, projections, caches and receipts.

Acceptance: Revocation during export stops further disclosure; failures resume and completion identifies held/pending items. Primary deliverable: `packages/governance/rights-executor`.

**FORGE-079 — Implement suppression ledger and external-processor acknowledgments** (governance/security). Prevent delayed messages/imports/restores from resurrecting data; track external requested/accepted/confirmed states independently; minimize protected ledger identifiers.

Acceptance: Old events cannot recreate erased records; external acceptance alone cannot become verified erasure; keyed tokens remain classified. Primary deliverable: `packages/governance/suppression`.

**FORGE-080 — Implement retention/crypto/recovery capability checks** (platform/governance). Bind retention jobs, backup and key capabilities; define failure models, restore drills, legal holds and evidence expiry.

Acceptance: Expired Dynamo TTL items remain inaccessible before cleanup; RPO/RTO assertions require measured evidence and cannot be inferred from a checkbox. Primary deliverable: `packages/governance/recovery`.

**FORGE-081 — Implement versioned control packs and evidence export** (governance). Create technical control mappings with sources, applicability facts, unknown/attested states and bounded OSCAL export. Subject rights legal disposition remains externally accountable.

Acceptance: A package cannot advertise blanket GDPR/FERPA/COPPA compliance; reports expose assumptions, review requirements and stale evidence. Primary deliverable: `packages/governance/control-evidence`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M20 — Generated dashboards, privacy-safe telemetry and evidence

**Objective:** Connect semantic contracts to measured runtime behavior without leaking governed data.

**Predecessors:** M18, M19, M16, M14

**FORGE-082 — Extend M8 OTel and SLI wrappers with governance context** (observability). Add stable action/purpose/surface identifiers, policy/grant epochs, decision outcomes and declared/observed edges; distinguish attempts/completions and transport failures.

Acceptance: Metrics contain only bounded approved labels; telemetry loss is reported; declared errors are not automatically successful service outcomes. Primary deliverable: `packages/runtime/observability`.

**FORGE-083 — Implement classification-aware logs/audit/redaction** (observability/security). Generate allowlisted structured events and controlled audit values; enforce sink-specific policies and mark raw logging escapes.

Acceptance: Sensitive payloads do not appear in generated logs, URLs, metrics or errors; unmodeled logger output is not labeled proven safe. Primary deliverable: `packages/governance/telemetry`.

**FORGE-084 — Implement dashboard and SLO-rule projection** (observability/tooling). Emit one certified dashboard/rule target with function/resource/channel/workflow/grant/privacy panels and provider detail links.

Acceptance: Unavailable metrics show missing support rather than zero; exact SLO buckets and logical counts match reference fixtures. Primary deliverable: `packages/interfaces/dashboards`.

**FORGE-085 — Implement signed deployment evidence and coverage accounting** (release/governance). Bundle build/contract/grant/policy/adapter hashes, test results, migration acknowledgments and runtime coverage windows, with confidential artifacts access-controlled.

Acceptance: Signatures verify provenance; missing or stale evidence remains unknown and cannot turn a bounded claim into universal compliance. Primary deliverable: `packages/registry/evidence`.

**FORGE-086 — Implement end-to-end drift and release verification reports** (observability/registry). Join declared, approved and observed graphs with assurance/coverage qualifiers; surface unexpected edges and expired snapshots; link semantic PR changes to dashboards.

Acceptance: No observed edge proves caller function identity beyond its assurance tier; absence in sampled telemetry is not unused-privilege proof. Primary deliverable: `docs/operational-verification.md`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

### M21 — Cross-profile certification and governed release

**Objective:** Release only the combinations and security claims the evidence supports.

**Predecessors:** M20

**FORGE-087 — Run differential correctness and fault-injection certification** (testing). Execute baseline plus extension cases across original clouds and certified PostgreSQL profiles; compare histories, schemas and disclosure surfaces.

Acceptance: Zero unexplained widening/semantic drift; every skipped case has an unsupported/not-applicable rationale and profile scope. Primary deliverable: `conformance/reports/`.

**FORGE-088 — Run security and supply-chain adversarial review** (security/testing). Exercise malicious packages/imports, CI PR changes, forged identity/purpose, cross-tenant leaks, policy races and exfiltration paths; independently review the TCB.

Acceptance: Blocking findings are closed or the affected assurance profile is withheld; TypeScript typing is never substituted for isolation evidence. Primary deliverable: `docs/security-review.md`.

**FORGE-089 — Benchmark overhead, scale bounds and resilience** (performance). Measure baseline-versus-governed latency, cache behavior, PIP/grant refresh, catalog recovery, write amplification and full workflow/subject job cost.

Acceptance: Report actual per-profile measurements and limits with workload definitions; no parity/performance promises without results. Primary deliverable: `conformance/benchmarks/`.

**FORGE-090 — Deliver Acme walkthrough, migration guide and business documentation** (docs/tooling). Demonstrate CRUD, purpose surfaces, API/MCP/CLI/SDKs, grants PR, registry outage/revocation, classified imports and erasure/recovery across supported profiles.

Acceptance: The same portable contracts and business code run without provider conditionals; unsynthesizable/external steps are explicitly shown. Primary deliverable: `docs/acme-next-walkthrough.md`.

**FORGE-091 — Publish versioned artifacts, support matrix and release evidence** (release). Pin all compilers/drivers/policy/taxonomy/protocol generators, publish compatible contract/runtime packages and signed conformance manifests with expiry/retest rules.

Acceptance: Each advertised combination lists exact versions, feature profile and evidence; unsupported combinations are not marketed as certified. Primary deliverable: `RELEASE_MANIFEST.json`.

**Milestone gate:** do not mark complete from code generation alone. Run the associated reference, integration and negative cases, retain artifacts, and list the exact certified profiles.

## 20. Dependency graph, integration order, and release slices

The first gate is **M8 evidence**, not an assumption that the original roadmap was implemented. M9 records any unfinished baseline obligations. Those obligations block features that rely on them.

```text
M8 evidence -> M9
                 |-> M10 adapters / PostgreSQL / Node --|
                 |-> M11 classification -> M12 purpose -|-> M13 enforcement
                                                         -> M14 interfaces
                                                         -> M15 registry
                                                         -> M16 grants/PRs
                                                         -> M17 diff/rollout
                                                              |-> M18 providers/deployments --|
                                                              |-> M19 subject rights --------|-> M20 evidence
                                                                                              -> M21 release
```

The graph shows completion gates, not a ban on parallel work. Teams can prototype registry storage, SDK emitters and provider connections earlier against draft interfaces. Security-sensitive activation must wait for the upstream semantic contracts and tests. Do not ship a catalog-driven agent integration before authorization and purpose surfaces exist.

Three useful reviewable slices:

**Slice A — governed local execution (M9–M13).** Existing M8 clouds keep working. PostgreSQL/Node is added. Classification and purpose compile into real scoped queries/services, with current Gatekeeper/authorization checks. This is the security foundation.

**Slice B — distributed contracts (M14–M17).** Open clients, discovery, registry and owner-approved dependency grants are introduced. Semantic diff and rollout coordinate the new security state. This is the organizational collaboration foundation.

**Slice C — additional deployment packs and evidence (M18–M21).** Qualify managed databases/self-hosting/Terraform, subject rights, dashboard generation and measured release claims. This is the broader adoption/release foundation.

Do not let a provider-integration project block unrelated compiler development, but do not broaden a release claim beyond the exact profiles whose behavior has passed. Keep D1 and Dynamo original profiles in the regression matrix throughout all slices.

## 21. Conformance specification and test execution

The package preserves **75 baseline scenarios** and adds **104 new scenarios**, `PAR-076`–`PAR-179`: **179 scenario specifications in total**. These are specifications to implement, not reported test passes. The 65 new work items continue from FORGE-027 through FORGE-091.

Each scenario has Given/When/Expected behavior, required profiles, evidence requirements and a primary implementation ticket. Local model tests validate deterministic semantics; live provider tests validate actual transactions, identities, queues, pooling, deployment and failures.

| Milestone | Extension scenarios | Main property |
|---|---|---|
| M9 | PAR-076–PAR-083 | M8 baseline does not become completion evidence and related negative cases |
| M10 | PAR-084–PAR-091 | Original target refactor preserves behavior and related negative cases |
| M11 | PAR-092–PAR-099 | Multilabel taxonomy inheritance and related negative cases |
| M12 | PAR-100–PAR-107 | Purpose hierarchy grants nothing and related negative cases |
| M13 | PAR-108–PAR-115 | Purpose/tenant/caller spoofing rejected and related negative cases |
| M14 | PAR-116–PAR-123 | OpenAPI reference lock and SSRF and related negative cases |
| M15 | PAR-124–PAR-131 | Digest pin defeats mutable tag and related negative cases |
| M16 | PAR-132–PAR-139 | Uses creates request not grant and related negative cases |
| M17 | PAR-140–PAR-147 | Pure diff does not invent live facts and related negative cases |
| M18 | PAR-148–PAR-155 | Neon connection profile and related negative cases |
| M19 | PAR-156–PAR-163 | Subject erasure respects other people and related negative cases |
| M20 | PAR-164–PAR-171 | Sensitive telemetry excluded and related negative cases |
| M21 | PAR-172–PAR-179 | End-to-end surface parity and related negative cases |

### 21.1 Test levels and correctness oracles

**Compiler/golden:** round-trip syntax, dependency resolution, source-linked errors, stable identities, structural/classification inheritance, flattened surfaces, effect digests, scoped wire models and physical plan snapshots.

**Reference algebra:** property-based tests for composition associativity/commutativity where defined, idempotent includes, sticky deny, attenuation, relationship closure and no taxonomy-derived authority. Mutation/query models use injected clocks/IDs and compare canonical results.

**Runtime unit/integration:** invocation isolation, serializers, policy inputs, egress wrappers, decision cache keys, strict result decoding, workflow context and subject restrictions. Test both local and remote authorizer/service bindings.

**Storage concurrency:** linearizability or invariant checking for the specified operation boundary; concurrent parent deletion, assignment changes, purpose-relevant revisions, effective intervals and hierarchy moves. Do not assert snapshot semantics the contract never promises.

**Deployment/cloud:** actual D1/Dynamo/Postgres transaction behavior, provider limits, driver pooling, auth/key access, queue fan-out, native workflow versions, outages, real Terraform/CDK/Alchemy plans and cleanup. Emulators do not certify real cloud permissions or consistency.

**Security/adversarial:** untrusted specs/packages/grant requests, confused deputies, stale privileges, cross-tenant caches, query oracles, forged purpose/caller identity, unsafe byte serialization, registry poisoning and restore resurrection.

**Cross-language:** same request/response/CLI/MCP and client fixture set across certified generator versions. Reference schemas must match the actual selected JSON/protocol capabilities, not just parse successfully in one tool.

### 21.2 Release report contract

Each scenario result records scenario ID, exact adapter/profile versions, source and executable digests, timestamps, fixture/seed, evidence location, pass/fail/not-applicable/unsupported status, coverage and known limitations. A skipped security test is not a pass. Performance tests report distributions and actual environments independently from semantic certification.

Artifact/package validation in this planning deliverable only checks JSON/TOML structure, ID/dependency consistency, expected capability examples and a small executable set-algebra reference model. It does **not** execute these 179 Forge/provider scenarios.

## 22. Risks, decision gates, and implementation discipline

| Risk | Failure mode | Required mitigation / stop condition |
|---|---|---|
| Capability type versus actual bytes | Full record is cast to a narrower TS type and serialized | Construct output from explicit allowlist; decode/validate at egress; negative wire tests. |
| Implicit authority inheritance | Purpose taxonomy or fragment reuse grants unrelated access | Taxonomy and grant algebra separate; sticky denials; explicit reviewed surface mapping. |
| Shared Layer contamination | Cached service/context captures a previous principal | Process clients separate from invocation context; per-operation checks; concurrent tests. |
| Unauthenticated function identity | Same workload fabricates a caller-function label | Honest assurance tiers; isolated callable boundary or trusted mediation where required. |
| Policy/data races | Assignment changes after an authorization read | Guard local attribute versions; document external PIP freshness/TOCTOU limits. |
| Cross-surface caching | Old broad responses escape through caches, receipts or export files | Surface/scope/policy identity in caches; reauthorization before disclosure; purge migration. |
| Foreign schema trust | Remote references or callbacks access private infrastructure | Pinned bounded imports, allowlisted destinations, explicit credentials/identity maps. |
| Registry hot-path dependency | Catalog outage becomes total application outage | Signed local snapshots; bounded stale/expiry rules; explicit security-availability tradeoff. |
| Grant laundering | Caller changes code/purpose under old approval | Security/effect envelope plus executable attestation; re-review material differences. |
| Overbroad catalog visibility | Internal schema/purpose names disclose sensitive business data | Authenticated projections and search/index filtering; metadata classification. |
| Provider flattening | A driver or queue silently weakens declared behavior | Exact capability matrix; bounded emulation or compile error; live certification. |
| Illegal state resurrection | Backups/messages/imports recreate erased data | Independently retained suppression/erasure ledger and execution checks. |
| Unfounded compliance claims | Configured control is labeled proven legal compliance | Evidence status, scope, reviewer context and unknowns; qualified review of profiles. |
| Feature explosion | Registry UI and every provider precede a correct kernel | Finish scoped execution slice first; independent adapters and explicit deferral list. |

Do not implement a second query/authorization/mutation engine inside each interface adapter. Do not let the registry write callee approvals directly as database rows without the configured ownership workflow. Do not use runtime telemetry as the only control over prohibited calls; enforce at the boundary and use telemetry as evidence.

## 23. Upgrading a real M8 implementation

This section applies only after M9 establishes what has actually shipped.

### 23.1 Backward-compatible technical foundation

Introduce versioned IR readers and adapter compatibility shims first. Existing `.forge` packages remain on their declared edition and profile until explicitly upgraded. Merely installing the next compiler must not add new public APIs, rename physical resources or reinterpret source/binding syntax.

Keep the original 75 scenarios unchanged as regression assets. A new edition can intentionally change semantics only with an explicit migration and updated compatibility profile; do not edit baseline expected results to make a regression disappear.

### 23.2 Governance adoption is staged, not magical inference

Run an inventory pass that proposes classification from semantic types and identifies unknown/free-text/blob/custom flows. Mark suggestions and provenance. Do not infer consent, legal basis, data ownership or purpose from column names or historic access alone.

Create explicit purpose and capability fragments with owners. A migration assistant can propose a surface matching an existing interface, but that is a review candidate—not automatic least privilege. Strict governed release admission requires unresolved authority/classification gaps to be acknowledged under the selected profile or fixed.

Refactor custom Effect implementations onto generated scoped services. Any use of full `.Record`, provider SDKs, generic logging or arbitrary outgoing HTTP is surfaced for review. Keep compatibility endpoints only with deliberate audience/policy controls; a legacy broad API must not undermine a newly minimized MCP surface.

### 23.3 State and authority rollout

Apply additive metadata/subject-index/schema changes through the current migration owner. Bind identity and Gatekeeper context, run new policies in an explicitly non-enforcing observation mode only where that does not claim protection, validate impact, then enable enforcement on designated surfaces.

Observation mode is not a security guarantee. Fail-closed scopes should not serve requests until policy/PIP coverage exists. Backfills and privacy jobs need their own narrowly scoped service authority, not an unbounded administrator identity hidden in a migration runner.

Publish immutable contracts, register actual deployments, obtain required callee grants, activate snapshots and invalidate incompatible caches/results. Preserve old workflow implementations where needed while checking current authority. Upgrade client interfaces and SDKs by explicit versioned surface.

### 23.4 Rollback plan

Retain compatible readers/storage representations during rollout. Application rollback does not roll back current revocations, erasure records, mandatory restrictions or audit evidence. A failed enforcement rollout requires an explicit authorized policy change, not an automatic switch to allow-all.

Database/provider rollback needs a data-consistency plan, not just old infrastructure templates. Quiesce/fence writes, validate transfer state, reconcile pending messages and document unrecoverable effects. Schedule destructive contraction only after the compatibility window and recorded approvals.

## 24. Included extensions versus deliberate deferrals

This roadmap is large enough without making every idea a new language primitive.

| Area | This roadmap | Deferred until independently justified/certified |
|---|---|---|
| Providers | D1, Dynamo, PostgreSQL; named managed/self-hosted profiles | All conceivable engine/runtime/IaC combinations; broad MySQL/Vitess support. |
| SQL facades | Effect SQL and Drizzle over common plans | Arbitrary raw SQL with preserved governance guarantees. |
| RPC/interfaces | Unary callables; HTTP/MCP/CLI; certified SDK tuples | All streaming protocols, all client libraries and all languages. |
| Workflows | Existing native adapters plus production self-hosted Temporal profile | New Forge durable workflow engine; automatic native-history translation. |
| Classification | Facets, extensible packages, conservative lineage and inspection interfaces | Universal detector accuracy; inferring real legal applicability automatically. |
| Policy | Gatekeeper adapter and a tested filtering subset with explicit obligations | Compiling arbitrary Rego to SQL or proving arbitrary policy equivalence. |
| Purpose | Explicit taxonomies, surfaces, composition, attenuation, transitions | Automatic inference of genuine intent or automatic legal compatibility from hierarchy. |
| Subject rights | Reviewed bounded locate/export/restrict/erase workflows | Autonomous legal adjudication, automatic global deletion of unknown external copies. |
| Feature flags | Can bind a typed evaluation callable/standard-library capability | Mandatory tenth application construct and full targeting-rule language. |
| Scheduling/coordination | Preserve M8 recurrence; use existing workflow/guard semantics | General actor language or arbitrary global distributed locks as portable primitives. |
| Crypto | Secret/key-operation capability contracts and adapters needed by security | Homegrown cryptography, unrestricted private-key export. |
| Registry | OCI-backed artifacts, catalog indexes, inventory and grants | Mandatory hosted SaaS, per-request registry authorization, universal execution proxy. |
| Formal assurance | Specified algebra properties, conformance and bounded evidence | Proof of arbitrary TS code behavior or absolute regulatory compliance. |

Dynamic one-shot scheduling and keyed serialization can be implemented later through existing source/workflow/capability contracts. They must include fencing, timeout, overlap and cancellation semantics, not merely another decorator. Preserve extension points without adding them to this release's critical path.

## 25. Definition of done and first engineering actions

The new release is complete only when:

1. M8 remains a certified regression baseline on its original targets, or any intentionally superseded behavior is explicitly versioned and migrated.
2. `.forge` data and purpose declarations produce checked capability surfaces and actual minimized wire output; forbidden operations and query inference paths are denied.
3. Generated Effect services keep reusable infrastructure separate from invocation authority, with per-operation Gatekeeper/row/mutation checks and bounded revocation.
4. Registry publication, catalog indexing, deployment reports and callee-owned grants have independent verifiable authority and survive the documented outage conditions.
5. OpenAPI imports, RPC bindings, MCP, CLI and certified SDKs share the same security and canonical data contract.
6. PostgreSQL and each advertised provider/runtime/deployment profile pass the required semantics; every untested combination is identified as unverified.
7. Diff, migration, grant activation, caches, workflow versions and data-rights state participate in a resumable safe rollout plan.
8. Acme and the two small industry fixtures demonstrate the intended scope without claiming legal or arbitrary-program correctness.
9. All advertised conformance cases have actual recorded evidence, with transparent exclusions, performance measurements and a versioned support matrix.
10. Generated PR/changelog/dashboard/evidence artifacts derive from the same contract identities, and secret/personal data is not placed in public package metadata.

**First engineering sequence:** establish FORGE-027 baseline evidence, ratify FORGE-028 semantics, implement FORGE-029 versioned IR, then start FORGE-032 adapter refactoring and FORGE-037 classification in parallel. The first security vertical slice should compile Contact.ParentCommunication, provide its nominal Effect reader, enforce one current Gatekeeper row policy, return only the approved fields, and pass identical negative tests on D1, Dynamo and PostgreSQL. Build the registry UI after that path works.

The updated plan is a continuation of M8 with a concrete implementation backlog. It is not a claim that the compiler, libraries, provider profiles, approval bot or cloud deployments described here have already been built.

---

## Appendix A. Primary-source references and baseline provenance

External sources validate existing ecosystem behavior, not the proposed Forge APIs. Checked for this plan on 20 September 2026. Pin actual dependency/protocol versions during implementation and recertify capability manifests after upgrades.

**B01.** Existing plan: *Forge: dual-target compiler and application runtime*, 17 September 2026, uploaded as `Forge_Dual_Target_Implementation_Plan.md`. SHA-256: `50ee2668f7fd1e23b0477e5c73dcb4d904d41e512d4d66c1a3cbd74b77848221`.

**B02.** Existing `Forge_Implementation_Plan_Package.zip`, containing baseline FORGE-001–026 and PAR-001–075. Their original JSON definitions are preserved in `specs/baseline-backlog.json` and `specs/baseline-parity-tests.json`; source example files are preserved under `examples/m8-reference/`.

**R01. Effect service requirements:** `https://effect.website/docs/v4/requirements-management/services`

**R02. Effect Layer memoization:** `https://effect.website/docs/v4/requirements-management/layer-memoization`

**R03. PostgreSQL row security:** `https://www.postgresql.org/docs/current/ddl-rowsecurity.html`

**R04. Cloudflare Hyperdrive query caching:** `https://developers.cloudflare.com/hyperdrive/concepts/query-caching/`

**R05. Neon serverless driver official repository:** `https://github.com/neondatabase/serverless`

**R06. PlanetScale PostgreSQL documentation:** `https://planetscale.com/docs/postgres`

**R07. Turso TypeScript SDK:** `https://docs.turso.tech/sdk/ts/reference`

**R08. Temporal workflow execution:** `https://docs.temporal.io/workflow-execution`

**R09. NixOS manual:** `https://nixos.org/manual/nixos/stable/`

**R10. Terraform JSON configuration:** `https://developer.hashicorp.com/terraform/language/syntax/json`

**R11. OpenTelemetry baggage:** `https://opentelemetry.io/docs/concepts/signals/baggage/`

**R12. Data Privacy Vocabulary v2 Community Group Report:** `https://www.w3.org/community/reports/dpvcg/CG-FINAL-dpv-20240801/`

**R13. GDPR official regulation text:** `https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng`

**R14. FTC COPPA FAQ:** `https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions`

**R15. US Department of Education: education records:** `https://studentprivacy.ed.gov/faq/what-education-record`

**R16. OPA filtering:** `https://www.openpolicyagent.org/docs/filtering`

**R17. OPA policy bundles:** `https://www.openpolicyagent.org/docs/management-bundles`

**R18. OAuth token exchange, RFC 8693:** `https://www.rfc-editor.org/rfc/rfc8693.html`

**R19. OpenAPI specification (resolved version to pin during implementation):** `https://spec.openapis.org/oas/latest.html`

**R20. MCP 2026-07-28 tools:** `https://modelcontextprotocol.io/specification/2026-07-28/server/tools`

**R21. MCP 2026-07-28 authorization:** `https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization`

**R22. Smithy code generation:** `https://smithy.io/2.0/guides/building-codegen/index.html`

**R23. Well-known URIs, RFC 8615:** `https://www.rfc-editor.org/rfc/rfc8615.html`

**R24. OCI Distribution Specification:** `https://github.com/opencontainers/distribution-spec/blob/main/spec.md`

**R25. GitHub CODEOWNERS:** `https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners`

**R26. Cloudflare gradual deployments:** `https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/`

**R27. Cloudflare OpenTelemetry export:** `https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/`

**R28. NIST OSCAL:** `https://pages.nist.gov/OSCAL/`

**R29. Alchemy D1:** `https://alchemy.run/cloudflare/data/d1/`

**R30. AWS CDK TableV2:** `https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_dynamodb.TableV2.html`
