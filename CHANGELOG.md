# Changelog

## Unreleased

### Added

- Console integrations: with `FORGEGRAPH_URL` and a read-scope `FORGEGRAPH_TOKEN`, every
  ForgeGraph app is listed as an integration described by its published contract (contract IR v1,
  converted to OpenAPI 3.1), and its operations can be called through the console. Base URLs,
  credentials (bearer, header or Cloudflare Access service token, `INTEGRATION_*` secrets only) and
  write access are set per app in `INTEGRATIONS_JSON`; reads are the default, writes need an opt-in
  and a per-call confirmation and are audited. The playground's new **Integrations** tab browses
  operations by group, builds requests from their schemas, confirms writes, keeps drafts per
  operation, and can hand an operation to the Graph tab's OpenAPI importer.
- `forgec build` writes `contract.json`, ForgeGraph's contract IR v1, next to
  `openapi.json` and derived from it: one operation per `@crud` route, `@http`
  function and workflow route, ids `<serviceId>.<group>.<endpoint>`
  (`--service-id` sets the app slug; the default is the unscoped package name),
  authentication from the security requirement, and each operation's SLO as
  `policy.slo`. Fingerprints are hashed over the bytes `JSON.stringify` would
  produce, so ForgeGraph's `validateContract` accepts the file as written; the
  conformance suite runs that validator, vendored, over a curated set of contracts
  and CI sweeps every package in the repository with `scripts/validate-contracts.sh`.
  `fg contract publish --file generated/contract.json` publishes it.
- `forgec import-contract <contract.json> --package <name> --out <dir>` turns a
  contract IR document into a Forge package through OpenAPI 3.1 and the OpenAPI
  importer, reporting RPC procedures, unbindable methods, anonymous or public
  operations, SLA/SLO policy, middleware, alternate media and non-Problem error
  bodies instead of approximating them. A contract whose fingerprints do not
  match is refused.
- `forgec contract-diff <a> <b> [--ignore <kind>]` compares two contracts per
  route (request and response schemas after `$ref` inlining, statuses, policy)
  and exits 1 on any difference not declared expected. See `docs/contract-ir.md`
  for the round trip and which differences it is expected to show.

- `@forgegraph/foundation/configuration` (experimental): typed parameterization
  against a pinned specification revision, layered defaults and overrides,
  deterministic resolution, and resolutions identified by a digest over their
  values. `Configuration` in `@forgegraph/runtime` resolves a chain and records it.

  Configuration is not arbitrary JSON: every value assigns a parameter the pinned
  revision declared, so an unknown key cannot be set and a key retyped in a later
  revision cannot be silently inherited. Layers carry an ordinal and a child's is
  strictly greater than its parent's, so precedence is a total order and resolution
  gives the same answer whichever end of the chain you start from. Every resolved
  value records which configuration supplied it, so a surprising value is
  attributable without re-deriving the chain by hand.

  Secret parameters carry a reference and never a literal, may not carry a default,
  and resolve to that reference. This package cannot dereference a binding, and a
  test scans the compiled contract for any field that could hold secret material.

  Seven criteria have local evidence; scalar type validation remains tracked in #94.

- `@forgegraph/foundation/reachability` (experimental): contact points and service
  endpoints as durable facts, with purpose labels, preference ranking, half-open
  validity, verification evidence and explicit supersession. `Reachability` in
  `@forgegraph/runtime` declares, verifies, supersedes and resolves them.

  Contact points and endpoints are separate resources rather than one polymorphic
  locator, because a data classification is a property of a field. A single `value`
  column has to be classified once: as `data.contact`, which sweeps webhook URLs into
  subject-rights erasure that does not apply to them, or as structural, which
  under-classifies an email address. `LocatorKind.personal` decides which profile a
  kind belongs to and a rule on each profile enforces it.

  No transport mechanics are foundation semantics here: a locator says where something
  can be reached, never whether a message was sent, how many attempts it took, or what
  a provider answered. A test asserts that structurally against the compiled contract.
  Notifications now consumes typed contact points and endpoints and checks their
  validity at notification time. All eight criteria have local evidence.

### Added

- `@forgegraph/foundation/consent` (experimental): consent grants, withdrawal,
  supersession and evidence as durable facts, with purpose, processing activity and
  data scope as three independent axes. `Consent` in `@forgegraph/runtime` grants,
  evidences, withdraws, supersedes and answers `effectiveAt`.

  Valid time and knowledge time are recorded separately, which is the point of the
  package. A withdrawal recorded on 1 March but backdated to 1 February gives three
  different correct answers: asked on 20 February about 15 February, consent held,
  because the withdrawal was not yet known; asked on 5 March about the same moment,
  it did not; asked on 5 March about 15 January, it held, because a backdated
  withdrawal reaches back only as far as it says. A decision made last Tuesday has to
  stay explainable with what was known last Tuesday.

  Consent is not authorization: these facts are one input to a decision, and a null
  result means no permission was recorded rather than a denial. Notification
  preference, agreement and entitlement are different facts with different lifecycles,
  and a test asserts structurally that none of them has appeared in this contract.

  This is a bounded valid/knowledge interpretation built from ordinary fields, not an
  L0 temporal facet; ConceptIR #75 is what would make those axes language-level.
  All eight criteria on #93 have executable local evidence.

### Changed

- **Breaking:** a projection's `latest` aggregate now names its ordering field:
  `latest <field> by <orderField>`. `latest` previously returned the greatest value
  of the field, so it was `max`; it now returns the value from the contribution with
  the greatest ordering field (a required integer, decimal, money, date or datetime
  field), with the record id breaking ties. Write order is never inferred. Bare
  `latest x` is `E-PROJ-006` with the fix-it `latest x by <field>`. Bundles from
  older compilers keep their previous behaviour. Migrate with, for example,
  `latest remainingFraction by observedAt`. (#198, #207)

### Added

- A reference to a record's own resource accepts `"$self"` on create and update,
  resolved to the id of the record being written, so a required self-reference
  (`root : Thread @immutable`) can be created. Admin import orders a
  self-referencing resource's records so in-snapshot targets come first. (#200, #206)
- `floor` and `datetime` arithmetic in resource expressions evaluate at runtime
  (`hour := floor(at / 3600) * 3600`), and the compiler accepts exactly the
  expression functions the runtime implements (`E-EXPR-004`); a parity test keeps
  the two lists equal. Previously any call compiled and then failed every create.
  (#196, #205)

### Fixed

- An optional `json` field's contract schema stays `{}` (which already admits
  `null`) instead of becoming `{"type": ["string", "null"]}`, which rejected every
  JSON value but strings.
- `D1Storage.list` omits `WHERE` when there are no predicates; a resource with
  neither `@tenant` nor `@softDelete` listed without filters failed with a SQLite
  syntax error. (#197, #203)
- OpenAPI contracts include `null` in the `enum` of a nullable enum field, so
  generated validators accept the null the API returns. (#199, #204)
- `/healthz` can now fail. Both hosts return 503 with the names of the absent
  settings when the instance's own configuration implies something it does not
  have — an R2 bucket, `REGISTRY_TOKEN_SECRET`, `INSTANCE_AUTHORITY`, the Access
  team domain and audience tag. It previously returned a constant `ok`, so a
  Worker deployed with no secrets reported healthy on every probe while
  answering 503 to every authenticated request, which is exactly what happened
  to `forge.gmac.io`. `.forgegraph.yaml` points a deployment health check here,
  so a probe that could not fail could not detect the only outage this
  deployment has had. Only names are reported, never values, and only absence is
  checked — a present but invalid signing key is a different failure and
  claiming to have checked it here would be the same kind of lie.
- `/v2` refuses outright when `REGISTRY_TOKEN_SECRET` is unset, instead of
  challenging the client with a `WWW-Authenticate` realm naming a `/v2/token`
  endpoint that does not exist. `docker login` could not exit that loop.
- `src/node.ts` passes a credential store to `createApi` and applies
  `migrations/0003_registry_credentials.sql`. Registry credentials were
  Workers-only by accident, so the panel answered 503 on every Docker
  deployment — and on the Playwright suite, which runs this host rather than the
  Worker, which is why no test saw it.
- README: corrected the release status. It claimed all five required profiles
  were certified against this build; `RELEASE_MANIFEST.json` reports
  `allRequiredProfilesCertified: false`, with two profiles' evidence bound to a
  superseded build and three carrying none. The manifest's auto-demotion rule
  worked; the prose had not followed it down. It also still described 0.3.0 as
  the current release.

### Added

- `packages/console/test/worker.test.ts` — the first test of the Workers
  entrypoint, which had none despite being the only place `/v2`, R2, D1, the
  credential store and the token endpoint are wired together. D1 is real
  `node:sqlite` running the real migrations, which no test had executed. It
  covers the missing-secret and missing-binding cases, and carries a credential
  from HTTP Basic through token exchange to an authorized request — a seam every
  component of which was tested and none of which was tested together.
- `packages/console/e2e/credentials.spec.ts` — issues a credential through the
  real UI against the real server. Verified to fail when the wiring above is
  removed.

## 0.4.0 (2026-09-24)

### Added

- ConceptIR business archetypes, typed Subjects, semantic identities and revision
  pins, traceability requirements, and explicit authority and boundary validation.
- Portable actors, work queues, search, sealed credentials, sequences, conditional
  uniqueness, typed collections, workflow maps, and incremental projections.
- Foundation contracts and composed systems, including capacity, inventory,
  projects, subscriptions, billing, returns, maintenance, rewards, and collections.
- Forge Studio business and developer views, editable records, source navigation,
  repository reviews, runtime connections, and Worker deployment management.
- Production console integration with Cloudflare Access, an R2-backed OCI registry,
  scoped registry credentials, and authenticated activity attribution.

### Changed

- Requires Node.js 24 or later.
- Expanded ConceptIR validation rejects ambiguous or unsupported models, including
  unsupported multi-hop reference expressions. Review compiler diagnostics when
  upgrading existing models.
- Foundation trust subjects use `TrustPartySubject`; regenerate dependent bundles
  and review updated package contracts before upgrading deployed applications.

### Fixed

- Concurrent workflow activity replay, PostgreSQL predicate conflict handling and
  contention retries, actor alarm supersession, and projection rebuild recovery.
- Collection contracts in SDK and GraphQL generation, SQL reserved identifiers,
  language-server completion and references, and editor syntax coverage.

- `forgec --version` printed `forge 0.3.0` and the language server announced
  itself as `forge`, both left over from the rename. The binary now identifies
  as `forgec` everywhere, including the `source` field on the diagnostics your
  editor shows. Cosmetic, but `forge` is a different tool on the machines this
  is most likely to be installed on.

## 0.3.0 (2026-09-21)

First public release. The project is now **ForgeGraph**: the compiler ships as
the `forgec` binary from the `forgegraph-cli` crate, and the runtime packages
are published on npm under the `@forgegraph` scope. Everything is Apache-2.0
and developed in the open at https://github.com/gmackie/forgec.

### Breaking

- The CLI binary is `forgec`, not `forge`. Every command, flag and output
  format is unchanged; only the name moved. `forge` is taken on crates.io and
  by Foundry, and the old name could not be published.
- npm packages moved from `@forge/*` to `@forgegraph/*`. Update imports; no
  API changed with the move.
- The library crates are `forgegraph-syntax`, `forgegraph-semantic`,
  `forgegraph-planner` and `forgegraph-codegen` (Rust paths
  `forgegraph_syntax` and so on). `forge-codegen` was already taken on
  crates.io by an unrelated project, and it is the fourth of five in publish
  order — a release would have discovered that only after permanently
  publishing the three before it. The other three names were free, but `forge-`
  is contested enough (Atlassian, Foundry, Aptos) that consistency is worth
  more than the names. Compiler output is unaffected: the generated bundle and
  its build hash are byte-identical across the rename.
- `createNodeHost` now **refuses to start without an `AuthHost`**. It
  previously fell back to development header auth, which meant a Node
  deployment that forgot to configure authentication trusted
  `x-forge-tenant` / `x-forge-actor` from the caller. Pass `auth`, or set
  `FORGE_AUTH=dev-headers` to opt into the development behaviour by name. The
  Cloudflare and AWS hosts already failed closed; all three now log a loud
  warning whenever development auth is active.

### Added

- Published artifacts: five crates on crates.io, nine packages on npm with
  build provenance, prebuilt `forgec` binaries for macOS and Linux on both
  architectures, and a Homebrew formula at `gmackorg/tap/forgec`. The tap
  *pulls* the formula from each release rather than being pushed to, so this
  repository holds no credential for it — see `docs/releasing.md`.
- `docs/stability.md`: a per-package stability tier, also recorded in each
  `package.json` under `forgegraph.stability`.
- `docs/releasing.md`: the release process, the required secrets, and how to
  bootstrap the shared Homebrew tap.
- CI (`.github/workflows/ci.yml`): compiler on stable and 1.97, runtime on
  Node 22 and 24 against PostgreSQL 17, a stale-fixture check, the
  cross-profile differential, a packaging dry-run, and supply-chain audits.
- Release automation (`.github/workflows/release.yml`) and a Forgejo mirror.
- `scripts/check-crate-names.mjs`, run by CI and again before a release starts:
  every workspace crate name must be free or already ours. crates.io names are
  permanent and publishing is ordered, so a name discovered to be taken partway
  through leaves everything before it published forever.
- The `LICENSE` file is now the full Apache-2.0 text. It was a 15-line notice
  pointing at the licence rather than a copy of it, while every crate and
  package declared `Apache-2.0` and shipped that file as their licence —
  Apache-2.0 requires the copy. It is also now inside each crate's own
  directory: cargo pulls the workspace README into a tarball but not the
  workspace LICENSE, so the crates would have published with none at all.
  `scripts/check-packaging.mjs` now checks the crate tarballs too, and fails if
  one carries no LICENSE, no README or no license field.
- `scripts/check-workflows.mjs`, run by CI: workflow files must parse, and an
  unquoted `${{ }}` inside a `with: { }` flow mapping is rejected by name. YAML
  reads the expression's `{` as opening a map, which invalidates the entire
  file — GitHub reports that as a run named after the file path, failing before
  any job starts, with no log to read.

### Changed

- `@forgegraph/temporal`: Temporal WorkflowDriver + worker; profile
  `self-hosted-full` certified on a single-node Temporal dev server.
- `@forgegraph/adapters/sqlite`: embedded libsql executor certified through the
  D1 adapter.
- `OtlpSink` and `telemetryFormat: "otlp"` on the Node host.
- Live deployment identifiers in `examples/acme` are placeholders. The
  certification evidence in `conformance/certification/latest.json` keeps every
  result and withholds only the private hostnames, marked as withheld.
- Re-certified live against build `cfc8286a` after the rename: Cloudflare
  (Workers + D1 + R2 + Queues + Workflows + Durable Objects + Cron Triggers)
  and AWS (HTTP API + Lambda + DynamoDB + S3 + SQS + Step Functions +
  EventBridge + API Gateway WebSocket), 15 scenarios / 221 steps each, realtime
  and provider switching in both directions, plus the differential across
  memory / sqlite-node / PostgreSQL with 0 unexplained differences. All five
  required profiles are certified against this build.
- `examples/acme/deploy/cloudflare/resolve-config.mjs`: the committed
  `wrangler.jsonc` keeps placeholders, and the `cf:*` scripts resolve a
  gitignored copy from `FORGE_D1_DATABASE_ID`. A public repository should not
  name someone else's database, and an editable placeholder is a placeholder
  waiting to be committed by accident.

- Re-pinned the adapter capability manifest digests in `examples/acme`, whose
  IDs moved to the `@forgegraph` scope.
- `cargo clippy -D warnings` and `cargo fmt --check` now pass workspace-wide
  and are enforced in CI.

### Fixed

Two concurrency defects, both found by CI on a clean machine after they had
hidden behind warm local state. Both were real: the first diagnosis of the
workflow one — "a flaky test, not a flaky runtime" — was wrong, and the poll
budget it widened was treating a symptom.

- **A workflow activity could run twice and report the wrong outcome.** The
  idempotency key for a workflow step embedded the *instance version*. That
  version moves whenever anything else touches the instance — a delivered
  signal, a competing driver — which is exactly what makes a step's save
  conflict and forces a retry. So the retry presented a key the idempotency
  store had never seen, the already-committed activity ran a second time, and
  it failed with `VersionConflict` against the record the first attempt had
  itself just moved. The workflow then reported `VersionConflict` instead of
  its real result: in the reference application, an order that should have
  failed with `ShortPayment` and been cancelled. Reproduced at roughly 1 run in
  6 under load. The key is now `wf:<instance>:<step>:<pass>`, stable across
  retries and distinct per loop iteration (`stepIdempotencyKey`, exported and
  unit-tested).

- **Independent concurrent writes failed on PostgreSQL.** Every commit writes
  `_forge_assert` and may write `forge_outbox`, so under `SERIALIZABLE` writers
  that share no business state still collide on predicate locks. A
  serialization failure there is the expected outcome and the documented remedy
  is to retry, but `PostgresStorage` inherited D1's retry budget — 3 attempts
  inside 75ms, tuned for a single-writer store where conflicts are rare. 64
  concurrent creates of distinct customers produced 10 `TransientConflict`
  503s. The retry budget and backoff are now overridable per adapter, and
  PostgreSQL uses 10 attempts with exponential backoff and jitter (~2s). Calls
  that succeed on D1 and DynamoDB now succeed on PostgreSQL, which is the whole
  point.

- `pnpm differential` no longer dies with `ENOENT` on the report file when the
  suite fails before writing one. It reported a missing file instead of the
  failure that was printed directly above it.

- The workflow-failure assertion in `conformance/scenarios/workflows.json` now
  gets the same 30s poll budget as the workflow-completion assertion beside it
  — consistency between two assertions of the same kind, not a fix.

## 0.2.0 (2026-09-21)

Post-M8 program M9–M21 complete. Live certification of both clouds on
build 693d221a70f7; differential across memory / sqlite-node / PostgreSQL;
RELEASE_MANIFEST.json lists every certified combination with evidence and
every withheld one with its reason.

- M21 release: differential certification, capability fuzz, adversarial
  suites, governance benchmarks, `forge upgrade-edition`, release manifest.

- M20 observability: telemetry governance context and attempt/completion
  phases; `@forgegraph/governance` redaction and sink policies; `@forgegraph/interfaces`
  dashboards; `@forgegraph/registry` signed evidence and drift reports.

- M19 governance: `@forgegraph/governance` (disposition planner, rights executor,
  recovery evidence, control packs + OSCAL); runtime suppression ledger
  (`Suppressed` 410 on recreation, import replays current suppression).

- M18 providers: `@forgegraph/adapters` (certification matrix, managed Postgres
  profiles + qualification, node:sqlite executor with the full conformance
  suite, resolved deployment plans, Terraform and self-hosted packs);
  `forge_outbox.trace` in the shared baseline; idempotent D1 migrations.

- M17 rollout: `forge compat` is now `forgegraph_semantic::diff` with direction,
  needs, interfaces/governance/dependencies/policy streams and `--report`;
  `forge migrate` emits a phased migration plan; deployment ledger
  (`@forgegraph/runtime` DeploymentLedger); export `excluded` section;
  `docs/provider-cutover.md`; `@forgegraph/release-gates`.

- M16 grants: `@forgegraph/registry/grants`, `approval-bot`, `grant-publication`;
  `schemas/dependency-grant.schema.json`; `docs/grant-lifecycle.md`.

- M15 registry: `@forgegraph/registry` (content-addressed signed artifacts with
  digest-locked resolution, rebuildable catalog with namespace/audience
  confidentiality and authority-qualified identities, deployment inventory
  separating signed reports from observations, signed expiring policy
  snapshots bounding any Authorizer offline).

- M14 interfaces: `forge build` emits `openapi.json` and `api.smithy`; every
  host serves `GET /forge/discovery` and `/forge/openapi.json`; new
  `@forgegraph/interfaces` package (RPC callable bindings, MCP server mounted at
  `/forge/mcp`, `forge-api` CLI) plus Python and Go SDKs certified on one
  cross-language scenario; `forge import-openapi` (pinned, offline, host
  allow-list); compiler E-WF-008 type-checks workflow step arguments.
- `localAuthorizer` evaluates policies independently (a policy whose PIP
  attribute is missing is skipped, never a reason to allow).

## 0.1.0 (2026-09-20)

First certified release of the dual-target toolchain: compiler (syntax,
semantics, planners, codegen, CLI with `check|fmt|inspect|lock|build|compat|lsp`),
Effect runtime with memory / D1 / DynamoDB adapters, Cloudflare and AWS hosts,
React workspace, and the conformance suite. Milestones M0–M8 of the
implementation plan; see `conformance/certification/latest.json`.
