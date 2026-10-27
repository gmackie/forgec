# Forge interconnected systems — composition and delivery RFC

**Status:** Implementing the first non-deploying slice (2026-10-27).
**Repository:** `gmackie/forgec`.
**Constraint:** Foundation's existing authoritative substrate/system model wins.
No universal `EntityRef`, `Task`, `Case`, `Request`, or arbitrary business JSON.

## Goal

Build installable cross-domain systems from pinned Foundation components,
trusted provider adapters and typed application-specific satellites. Expose
HTTP/OpenAPI, typed SDK and MCP views over the **same enforced operations**;
presentation skins own terminology, not the underlying business facts.

Forge's `.forge` compiler/runtime remain the only authoritative schema and
execution substrate. The new `@forgegraph/system-composition` package begins as
a read-only planner and two read-model libraries, not a second runtime.

## System capabilities

| System | First integration | Acceptance that must be independently proved |
|---|---|---|
| Change Intelligence | KanBanger issue + ForgeGraph changeset + Loom/SCM revision | PR edit invalidates stale policy/plan approvals; ambiguity prevents confident impact; deployment observation not inferred from dispatch |
| Action Center | KanBanger task, approval decision, ForgeGraph intervention | One actor-filtered view; tenant isolation; version gaps hide actions; source remains authoritative for lifecycle |
| Commitments | Agreement/Entitlement/Fulfillment/Settlement | Exact accepted terms, fulfillment evidence and acceptance separated; task closure never pays obligation |
| Exception Operations | CRM/payment/ERP provider with Reconciliation + Case | Retry after uncertain provider result uses original idempotency; remediation final only after re-observation |
| External Collaboration | Two separate organization identities and a document | External scopes don't leak internal files, signer authority validated at commit, evidence revision pinned |
| Resource Operations | Technician/compute pool and requested operation | Atomic capacity claim, eligibility checked on consumption, fulfillment verified independently of assignment |
| Knowledge Governance | SOP + policy config + Records | Exact edition/revision and effective config; downstream impact of changes; retention holds block disposition |
| Governed Agent Operations | Human agent delegate, Gatekeeper, quota | Child agent cannot exceed parent scope/budget, required approval bound to exact operation, uncertain remote effect remains pending |
| Business Economics | Usage + Billing + Ledger + Settlement | Dedup metering, bounded atomic posting and balanced ledger, payment acknowledgement not settlement |
| Process Simulation | Historical fixtures and isolated host | Deterministic inputs and version pins; zero production mutations; comparative evidence of behavior changes |

## Phase 0 — contracts and ownership (implemented in this PR)

- Registry of the ten compositions names its *required* Foundation packages,
  trusted external provider ports, operations, purposes and domain invariants.
- Read-only closure planner imports actual `contract.json` dependency graphs
  and produces stable content fingerprints and unverified readiness status.
- Action Center projection supports producer ownership, tenant/assignee read
  filtering, source-revision fencing, upstream command dispatch and explicit
  non-atomic semantics.
- Change Intelligence advisory projection requires revision- and plan-bound
  evidence. It doesn't substitute for ForgeGraph's merge/deploy authority.
- Unit tests cover positive/negative paths and changeset/version staleness.

## Phase 1 — installable composition profiles

- Introduce reviewed `forge.toml` entry packages for each system with explicit
  `[dependencies.<name>] deploy = true`. Don't infer transitive co-deploy from
  contract imports alone. Generate lockfiles with real `forgec lock` and run
  `forgec check`, `forgec build`, `forgec compat` against pinned compiler/runtime.
- Build typed application satellites and command handlers; never copy lower
  Foundation facts into new authoritative generic tables.
- Wire an authenticated service boundary and per-operation purpose Gatekeeper
  evaluation. `list` projections must not leak hidden source identities.
- Add real durable provider event adapters and a replayable inbox/outbox; every
  external side effect requires a backend idempotency key and verification.
- Produce OpenAPI/typed client/MCP projections from the compiled contracts;
  MCP tools cannot bypass original API permission checks.
- Run conformance on supported memory/SQLite/Postgres local profiles, then
  individual hosted D1/Dynamo profiles before asserting certified behavior.

## Phase 2 — production vertical: change control

1. A KanBanger task pins an original immutable SourceAnchor and optionally a
   logical IaC resource; re-resolution is a separate advisory fact.
2. A source change / GitHub PR / Loom Changeset maps to ForgeGraph's stable
   repository-scoped change identity and exact changing revision.
3. A review computes impacts (code symbols, configuration, infrastructure,
   policies), marking missing/ambiguous/denied separately from resolved.
4. Change Foundation pins from/to specifications and evaluations.
5. Separate Approvals records a decision on the **exact** source revision,
   plan digest and selected business option. Gatekeeper independently evaluates
   the principal's permissions.
6. ForgeGraph remains the only delivery executor and maintains environment-
   specific build, deployment, runtime observation and rollback evidence.
7. Reconciliation compares desired and observed state; the work graph presents
   related work and evidence without treating merge as verified production.
8. PR modification, stale approvals, missing evidence, rollback, partial deploy,
   tenant denial and replay races are all negative tests.

## Phase 3 — second independent domain: commitments and exceptions

- Compose vendor/customer agreements, evidence-backed acceptance and settlement
  as a non-SDLC deployment that doesn't import KanBanger vocabulary.
- Exercise a real multi-step reconciliation against at least two external
  systems, with failure injection between provider effects and local commits.
- Reuse the Action Center for tasks, approval invitations and investigations.
- Prove that domain UI and MCP can change without changing lower business
  authority or creating a parallel task/approval implementation.

## Phase 4 — remaining seven systems and Application Studio

- Deploy external-collaboration, resource-operations, knowledge-governance,
  governed-agent-operations, business-economics, process-simulation profiles.
- Application Studio selects signed and version-pinned packages, renders
  contracts, initializes domain projects, checks migrations and policy bindings,
  and performs preflight simulation. It is a developer UX over `forgec`, not an
  extra data/execution engine.
- Multi-party tenant boundaries, provider failure behavior, exact-date
  temporal rules, cost and usage ceilings, large datasets and compatibility
  upgrades each need workload-specific hosted provider tests.

## Ownership / data movement

| Authority | Authoritative for | Not authoritative for |
|---|---|---|
| WorkGraph / KanBanger | SDLC work, documents, typed work-source links | PR source bytes, deployment evidence, approvals |
| Loom / SCM | source snapshots, PR/diff positions, semantic anchors | whether work is complete |
| ForgeGraph | changesets, builds, tests, rollout and production evidence | work backlog, business permission grants |
| Approvals service | invitation, quorum, signed decision, expiry/reconsideration | actor privileges, external side effects |
| Gatekeeper | authorization policy, scope, live principal PIPs, decision logs | successful approval or execution |
| Foundation | typed business facts and validated cross-domain state | application-specific UI vocabulary and remote provider control |
| Action Center | filtered, potentially stale actionable projections | all of the above |

### Cross-system recovery requirements

Every adapter must choose (and document) the source of truth. No remote call is
part of a local database transaction; dispatch uses a durable intent, backend
idempotency and reconciliation of uncertain results. Consume provider events
with monotonic, provider-scoped versions; a gap fences the projection until a
verified snapshot is fetched. Do not report exactly-once cross-provider effects.

### Release / acceptance gates

- **Compile:** real package `.forge` import closure builds; compiler/IR and
  generated OpenAPI/Smithy/SDK artifacts are deterministic.
- **Local behavior:** exercised Foundation helpers, host policy checks and
  invalid direct-CRUD attempts, race/idempotency/tenant negative cases.
- **Integration:** real app source revision and authenticated API request-to-
  provider trace, not synthetic package consumers alone.
- **Hosted:** CI captures provider, compiler, bundle, policy, fixture and
  source hash; unverified hosted combinations remain explicitly unverified.
- **Operations:** replay, dead-letter recovery, outbox lag, audit/retention,
  monitoring, rollback and migration rehearsal before production cutover.

## Definition of complete

Ten installed and interoperable systems in two materially different real
applications; end-to-end tests from UI and MCP through policy to durable
business facts and external verification; documented migrations; passing
release-specific hosted provider evidence; no silent missing proofs. A catalog
or passing isolated Node test is **not** that state.

## Current checkpoint — 2026-10-27, durable local backend

The first follow-on slice to PR #242 now includes the Node SQLite action ledger,
trusted-producer HMAC ingest, actor/purpose-bound REST and MCP entrypoints,
revision-gated change evidence collector, WorkGraph source reference resolver,
actor-scoped KanBanger API reader, and non-SDLC Commitments/Exceptions
read-through inspectors. Cross-domain **local** tests are passing (64 passing,
one repository-only skip in the isolated artifact); the job added to
`.forgejo/workflows/ci.yml` is designed to make that repository integration
test mandatory on Forgejo. Source and doc changes are additive; runtime and
Foundation records are not migrated or replaced. See
`docs/systems/backend-trust-boundaries.md` for explicit security contracts.

**Still open:** actual provider API bindings for Approvals/Gatekeeper/ForgeGraph
and Loom P1, a certifiable hosted ledger implementation, authenticated
request-to-provider evidence from real deployments, package compiler/lockfile
verification against this commit, real non-SDLC end-to-end provider tests,
UI/Application Studio and ten individually accepted release packages. The
result is a working local composition backend, **not** a production-ready
installation of all systems.
