# Security and supply-chain review (FORGE-088)

Scope: the trusted computing base (TCB) of a Forge deployment and the adversarial suite that exercises it.
This is an engineering review with test evidence; it is not a third-party audit and does not certify any
assurance profile beyond what is stated below.

## TCB

| component | trusted for | not trusted for |
|---|---|---|
| compiler (`crates/forge-*`) | IR, contracts, capability algebra, digests | nothing at runtime |
| `@forgegraph/runtime` engine | validation, guarded commits, purpose projection, gatekeeper decisions, suppression ledger | isolation between callers in one process |
| auth host (`jwtAuth` / dev headers) | binding the trusted invocation context | credential issuance |
| storage adapters (memory, D1, DynamoDB, PostgreSQL, node:sqlite) | atomic batches, unique claims, reference guards, physical budgets | authorization (they see projected results only) |
| registry (`@forgegraph/registry`) | artifact integrity, catalog confidentiality, grants, snapshots, evidence | executing anything |
| hosts (Workers, Lambda, Node) | ingress, telemetry sinks, sweeps | tenant isolation beyond the credential |

**TypeScript types are not isolation evidence.** Purpose surfaces, nominal reader keys and grant checks are
runtime checks over projected objects; a caller in the same process with a reference to the engine can call
`callInternal`. The `isolated-callable` assurance profile is **withheld**: no test demonstrates an attested
boundary, and `assuranceProfile()` reports `workload-bound` for a shared process.

## Adversarial suite (what runs in CI)

| threat | test | result |
|---|---|---|
| malicious package with install hooks | `crates/forgegraph-semantic/tests/compile.rs::dependency_resolution_never_executes_package_code` | never executed |
| malicious OpenAPI (remote refs, SSRF hosts, pinned digests) | `crates/forgegraph-codegen/tests/openapi_import.rs` (PAR-116) | refused offline |
| foreign id passed as a Forge reference | `compile.rs::workflow_arguments_are_type_checked_against_the_callee_contract` (E-WF-008) | compile error |
| forged identity / purpose headers | `packages/runtime/test/gatekeeper.test.ts` PAR-108 | ignored under JWT auth |
| cross-tenant reads | every profile: NotFound for other tenants (`http.test.ts`, differential) | no disclosure |
| policy races / stale allows | `gatekeeper.test.ts` PAR-111/112, `registry/test/snapshots.test.ts`, `adversarial.test.ts` PAR-173 | epochs revoke cached allows; queued old work refused |
| capability composition widening | `crates/forgegraph-semantic/tests/capability_fuzz.rs` (PAR-174) | matches reference algebra under permutation and wrapper attacks |
| tampered artifact / registry response | `registry/test/artifacts.test.ts` PAR-125, `adversarial.test.ts` PAR-175 | digest or signature refused before activation |
| CI PR overlays, bot escalation | `registry/test/grants.test.ts` PAR-133/136, `adversarial.test.ts` | projected away; no execution path; path/repo escalation refused |
| forged or altered grants; activation without snapshot ack | `grants.test.ts` PAR-137/138, `adversarial.test.ts` | refused |
| exfiltration through logs/metrics/errors | `packages/governance/test/telemetry.test.ts`, `runtime/test/telemetry.test.ts` PAR-164 | allowlisted sinks; raw logging marked unmodeled |
| resurrection of erased data (delayed events, restores) | `governance/test/rights.test.ts` PAR-158/159 | suppression ledger |
| revocation mid-export | `rights.test.ts` PAR-161 | disclosure stops; artifacts disposed |
| secret bytes in build outputs | `packages/adapters/test/deployment.test.ts` PAR-152 | references only |
| rollback restoring revoked authority | `registry/test/rollback.test.ts` PAR-145 | refused |

## Findings

| id | finding | status |
|---|---|---|
| SR-1 | `localAuthorizer` denied on the first policy with a missing attribute instead of evaluating others (M13) | fixed (M14): policies evaluated independently; missing attributes never allow |
| SR-2 | write-capable purpose surfaces hid `version`, so callers could not do optimistic concurrency and a benchmark measured fast failures as fast writes | fixed (M21): surfaces with update/actions expose `version` |
| SR-3 | incremental D1 migrations repeated baseline DDL, so a fresh deployment applying all migrations would fail | fixed (M18) |
| SR-4 | snapshot-bounded authorizer decided from a fixed policy set instead of the activated snapshot's | fixed (M21): `withSnapshotAuthority` takes a factory |
| SR-5 | `isolated-callable` assurance has no attested boundary | open: profile withheld |
| SR-8 | Temporal-backed profile was unverified | closed (post-release): `@forgegraph/temporal` certified against a Temporal dev server (single node); cluster/cloud tuples remain unverified |
| SR-6 | OTLP wire export not implemented; sinks were Workers Logs / EMF / custom | closed (post-release): `OtlpSink` (OTLP/HTTP JSON logs + metrics, bounded attributes, loss counted), `telemetryFormat: "otlp"` on the Node host |
| SR-7 | The `Suppressed` guard keys on the subject's declared binding; records reaching a subject only through an undeclared path are not covered | open by design: undeclared paths are reported as unknown lineage by the planner |

## Blocking-finding rule

A blocking finding is closed before release or the affected assurance profile is withheld from
`RELEASE_MANIFEST.json`. SR-5 withholds `isolated-callable`; every certified combination in the manifest is
`workload-bound`.
