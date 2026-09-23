# Foundation ownership and composition

Foundation owns durable, cross-domain facts between the stateless standard library and domain/application packages. Substrates own small authoritative graphs. Systems compose those graphs and own the additional facts required by their horizontal process. Domain wrappers retain domain terminology, request payloads, observations, verdicts and detailed outputs.

Admission is mechanical:

| Proposed behavior | Owner |
| --- | --- |
| New provider, storage or execution guarantee | Kernel |
| Stateless composition of existing semantics | Standard-library facet or pattern |
| Cross-domain authoritative durable fact | Foundation substrate or system |
| Domain/business vocabulary or payload | Domain/application |

Application resources point outward to sidecar aggregates. Domain-owned typed satellites point to Foundation envelopes. Heterogeneous relationships use substrate-specific handles, such as LineageNode, never a universal EntityRef or a resourceType/id pair. Foundation does not standardize universal Task, Case, Request, Result or arbitrary JSON payload schemas. DecisionCase and AdjudicationCase are owned process facts, not universal Case abstractions.

## Package contracts

`packages/foundation/<slug>/contract.json` is the machine-readable ownership and acceptance contract; `contract.md` explains its semantics. Contracts define ownership and acceptance. Specification, artifact, identifiers and participation now have executable implementations with local passing evidence; other acceptance records remain `planned`. The catalog covers issues #26–50; `node scripts/verify-foundation.mjs --suite contracts --all` checks coverage, unique case IDs, dependency direction and cycles.

Logical Forge identities are `@forgegraph/foundation/<slug>`. They are not npm names. Optional npm distribution wrappers use `@forgegraph/foundation-<slug>`. Initial versions are experimental `0.1.0`; exact source/contract content and compiler versions must be locked. A version label is not an integrity check. Required-field and operation changes require consumer compatibility checks.

Dependency direction is kernel → std → substrates → systems → domain/apps (arrows mean supports). Within Foundation, each package lists its exact predecessors. Substrates never import systems; systems may import only earlier systems. Reverse provenance associations belong in typed higher-layer bridges. Artifact does not import Lineage just to associate an artifact with a lineage node; Agreement owns its issuance link to Entitlement, never the reverse import.

## Explicit co-deployment

An ordinary path dependency remains an imported contract. Setting `deploy = true` on a dependency opts its package into the application's local deployment closure, including its own opted-in dependencies. Compilation remains offline. All required source dependencies must be materialized at accepted revisions in the isolated workspace; compiled-only package resolution is not implied.

Selected packages share a storage and transaction domain. Assembly retains package-qualified declaration/resource/function IDs and typed references. It must deduplicate identical diamond dependencies and reject conflicting package identities/versions, dangling local resource references and ambiguous physical/wire names. The first slice rejects collisions rather than renaming existing storage. The bundle, storage planner, migrations and compatibility tooling must see the same selected closure.

Remote callable dependencies stay outside the atomic transaction boundary. They require explicit implementation bindings; importing or co-deploying a function does not silently turn `external()` into an atomic nested call. All dependency function bodies are explicitly registered by stable ID. The initial executable gate invokes those functions directly and exercises explicit remote bindings. Nested local callable transactions need a separate verified dispatch contract before systems rely on them.

Pure facet/pattern expansions must not load source libraries at runtime. Durable resources/contracts do remain runtime-owned model entries. The existing unmerged facet and semantic-source-map changes should be reused after review rather than reimplemented. Source paths and spans belong in build-bound provenance sidecars, not canonical semantic identity.

## Invariants and verification boundaries

Allocation needs a capacity guard mutated in the same atomic commit as the claim; pre-write counting is insufficient. Ledger needs bounded atomic posting groups, immutable posted records, explicit reversals and rebuildable balances. Neither a passing memory test nor immutable field annotations alone prove these guarantees. These are separate gates and must not block unrelated packages.

Participation is not entitlement, and neither grants authorization by itself. PIP examples expose facts to normal governance. WorkQueue Task is execution machinery, not a business fulfillment. External delivery deduplication does not guarantee exactly-once provider effects; uncertain acknowledgments retain explicit durable history.

The shared runner distinguishes contract validation, an executable composition slice and future per-package behavioral/provider verification. Planned packages fail executable verification until they have a real implementation and verifier. Required provider coverage must fail when unavailable; no silent skips count as certification.

## Agent ownership

Each package worker owns its package contract, source, implementation and focused tests in a separate workspace. The integrator owns catalogs, root scripts/manifests/lockfiles, shared CI, generated fixtures and cross-package verification. Compiler and runtime changes are integrated before dependent package work. Handoffs name the accepted dependency revisions, exact commands, pass/fail/skipped counts and unresolved provider coverage.

Lifecycle patterns are stateless finite-run, retry/deadline, decision-gate, expiry, reconciliation-loop and qualification behaviors. Durable attempts, responses, reservations and releases stay in their respective packages. Pattern syntax and expansion are not implemented by the contracts in this change.
