# Threat model (FORGE-031)

Each claimed property names its enforcement point, assumptions, evidence and a
negative scenario. Properties without evidence are marked **pending** and stay
pending until a test exists; absence of telemetry is never evidence (D20).

## Trusted computing base

| component | trusted for | not trusted for |
| --- | --- | --- |
| Rust compiler (`forge`) | deterministic, offline compilation; identity and digests; refusing unknown critical IR | anything at runtime |
| `@forge/runtime` engine + adapters | validation, integrity guards, audit/outbox co-commit, receipts, fences | authenticating principals (delegated to `AuthHost`) |
| Provider primitives (D1 batch, DynamoDB transactions, Queues/SQS, Workflows/Step Functions, DO/API Gateway) | atomicity and durability as documented by the provider | tenant isolation beyond what the key/claim model encodes |
| `deploy/` (wrangler/CDK) | binding the right resources | the correctness of application semantics |
| Extension manifests | declaring capabilities | running code (they never do) |

Handwritten `impl/` code is inside the trust boundary of its own package: `uses`
declares potential effects (D06) and the runtime exposes only declared
capabilities, but a function body can still misuse what it is given. Static
`uses` is not a sandbox (D10).

## Properties

| # | property | enforcement point | assumptions | evidence | negative scenario |
| --- | --- | --- | --- | --- | --- |
| T1 | A request acts only as the principal the `AuthHost` returns; tenant scope comes from trusted context, never from the body. | `createHttpHandler` → `AuthHost.authenticate`; every storage key is tenant-prefixed | production supplies a real `AuthHost`; `dev-headers` is development-only | `m2.site-references` (cross-tenant reads/cursors fail), `packages/runtime/test/http.test.ts` | a cursor from tenant A used in tenant B → `InvalidCursor` |
| T2 | Every write is validated, guarded and audited in one atomic commit; a failed guard leaves no audit/outbox row. | adapter `commit`/`commitAll` (D1 batch with named CHECK, DynamoDB TransactWrite) | provider atomicity | `m3.integrity`, `packages/runtime/test/faults.test.ts`, spikes | delete racing a child create never orphans |
| T3 | Idempotency receipts prevent duplicate effects; a reused key with a different body is refused. | `withIdempotency`, receipt written in the same commit | key scoped by tenant + operation | `m2.idempotency`, `m8.limits` | key reuse with a different payload → `IdempotencyMismatch` |
| T4 | Consumers dedup messages by id; poison messages park, never loop. | `Functions.consume` processed ledger; dispatcher lease/attempts | at-least-once transports | `packages/runtime/test/dispatch.test.ts`, `m5.messaging` | redelivered envelope is a no-op |
| T5 | Signals only reach the wait step whose correlation key they match; late/duplicate signals are inert. | workflow inbox keyed by (workflow, step, message, key), dedup by messageId | callers of `/signals` are authenticated operators or channel deliveries | `m7.workflows`, `packages/runtime/test/workflows.test.ts` | signal after cancel → `delivered: 0` |
| T6 | A deployment never reinterprets an in-flight workflow instance. | `(version, graphHash)` pin in `advance`; `forge compat` | graph hash covers the whole step graph | `WorkflowVersionMismatch` test; compat `graph-changed-without-version` | same version, changed graph → refused |
| T7 | Function identity: the runtime knows which *logical* function ran (telemetry `forge.operation`); it does **not** prove which code inside a shared process executed (D16). | telemetry emitter | shared-process deployment | `packages/runtime/test/telemetry.test.ts` | **pending**: strict isolation needs an attested boundary (M13) |
| T8 | Raw escapes: no interface writes to D1/DynamoDB outside the engine's commit path; admin export/import go through the same adapters. | adapters are the only storage clients; `impl/` receives capability objects, not clients | `deploy/` does not hand raw bindings to application code | `conformance/test/switch.test.ts`, code review | **pending**: a lint that forbids raw binding use in `impl/` (M13) |
| T9 | Compilation executes no package code and reaches no network; unknown critical IR features fail closed. | `load_package` reads `forge.toml` + `.forge` only; `DomainIR::load`; `[extensions]` digest + shape checks | filesystem read of the declared paths only | `dependency_resolution_never_executes_package_code`, `ir_loading_fails_closed_on_unknown_critical_features`, `check_validates_pinned_extension_manifests_without_executing_them` | a manifest with `main` → `E-EXT-002` |
| T10 | Semantic digests separate documentation from wire and security surfaces; a doc edit never requires reapproval, a new effect does. | `DomainIR::digests()` | canonical key-sorted serialization | `separate_semantic_digests`, `security_only_change_moves_only_the_security_digest` | added `sends` moves the security digest |
| T11 | Telemetry carries no tenant, ids or inputs as dimensions. | `Telemetry.dimensions` | sinks format only | `telemetry.test.ts` (unbounded values absent) | tenant name never appears in labels |
| T12 | Provider switching preserves identities and revisions and verifies before cutover; writes are fenced meanwhile. | `admin.fence` checked in `mutate`; `admin.verify` hashes | operator runs the sequence | `switch.test.ts` both directions | verify reports a divergence after a post-export edit |
| T13 | Subject linkage: soft delete is not erasure (D21); classified fields and subject bindings are declared (edition 2027) but not yet enforced at read time. | IR only | — | governance lowering tests | **pending** (M11–M13): field-level minimization, retention, erasure |
| T14 | Purpose attenuation: runtime restrictions can only intersect the static surface (D09). | **pending** (M12/M13 `EffectiveCapabilityIR` + gatekeeper) | — | — | **pending** |
| T15 | Registry outage: contracts and grants are immutable artifacts; an unreachable registry blocks *activation* of new edges, never execution of already-verified ones (D14/D17). | **pending** (M15/M16) | — | — | **pending** |

## Out of scope for this edition

Side channels, provider compromise, malicious `impl/` code exfiltrating data it
was legitimately granted, and physical residency proofs. Those need attestation
and provider-side evidence, tracked as `external evidence required`.
