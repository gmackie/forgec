# Resource relations and settlement: semantic boundaries

Updated 30 September 2026. This document records the integration contract for Foundation issues #79 and #80. Application integrations remain deferred.

## Checked compiler bindings

ConceptIR `concept-ir/2` supports temporal axes, typed relationships, event/effect declarations, contracts, and participant views. These are semantic declarations; their presence does not prove that an arbitrary implementation enforces them.

Both packages now ship `fixtures/semantics.json`. Inspect the bindings against the compiled package and its dependencies:

```sh
forgec inspect packages/foundation/resource-relations --concept --semantics packages/foundation/resource-relations/fixtures/semantics.json
forgec inspect packages/foundation/settlement --concept --semantics packages/foundation/settlement/fixtures/semantics.json
```

The compiler checks temporal timestamp types and relationship endpoint types in a closed graph. Explicit bindings expose server-generated `createdAt` as knowledge time without modifying executable DomainIR or its hash. Invalid fields, missing targets, and conflicting effective-dated validity declarations fail validation. Ordinary legacy projection still omits unrequested synthesized fields.

Resource relations binds Party, ResourceSubject, RelationKind, and RelationScope to the authoritative relation carrier, and distinguishes source occurrence, relation validity, and commit knowledge. Settlement binds creditor/debtor Party and Obligation to one position; it distinguishes source/event occurrence, event validity, and commit knowledge. Package runtime tests separately establish publication seals, authorization, concurrency, and historical queries.

The bridge deliberately does not infer general knowledge-history storage, business contracts from row rules, or immutable business events from messages. Legacy `Selection.during`/`as_of` do not by themselves identify a temporal axis. Event/effect custody declarations and broader cross-output realization proofs remain independently scoped compiler work.

## Accepted package temporal contract

Both packages declare their business times explicitly. Occurrence identifies when the source event happened; valid/effective time identifies when a relation or settlement contribution applies. These fields may carry reviewed historical times. They must not silently stand in for the time the system learned an authoritative fact.

`knownAt` is evaluated against kernel-recorded server timestamps on the authoritative publication seal and subsequent end/correction facts. A staged candidate is not authoritative merely because it has a timestamp or appears in a list. A candidate becomes visible to semantic queries only when its required immutable publication fact is present, valid, authorized, and known at the selected instant. Client-supplied `recordedBy`, source timestamps, and arbitrary `knownAt` values cannot backdate server knowledge.

Queries combine both axes: first restrict to facts published by the selected knowledge time, then interpret their effective interval and corrections. A termination learned later may change a current reconstruction of an earlier effective date; it must not rewrite what an earlier knowledge-time query could see. Define and test half-open validity intervals, UTC-normalized instant comparison, and deterministic handling of equal timestamps. If timestamps cannot order conflicting facts, use an explicit durable journal order or fail closed; do not infer causal order from IDs or wall-clock precision.

Publication, authorization, and concurrency remain independent checks. A valid historical fact is not permission to disclose it. A pre-read followed by an unfenced write is not sufficient to preserve a concurrent quantity or exclusive-custody invariant.

The authored bridge binds these package fields to compiler-level temporal facets. By itself it does not establish runtime equivalence. The bounded SQL/Dynamo example combines these checked bindings with identical historical-query assertions across providers; see [temporal realization evidence](temporal-realization-evidence.md) and the source-bound provider certification. A generic runtime executor for arbitrary ConceptIR selectors remains outside this package scope.

## Package ownership and dependency order

| Work | Existing dependencies and ownership | Deferred semantic integration |
| --- | --- | --- |
| #79 resource relations | Party; immutable relationship-kind SpecificationPin; typed package Resource identity or domain-owned typed resource satellite; evidence and provenance where used. Ownership, control, custody, operation, hosting, and payer roles remain distinct. Allocation is a separate reservation contract. | Temporal and typed relationship bindings are checked. #76 event/effect custody handoffs remain separate. |
| #80 settlement | `entitlement.Obligation` (#30), Fulfillment (#31), Agreement/`AgreementObligationLink` (#43), Party, and explicit Ledger (#36) bridge. Position, materialization, settlement allocation, reversal, source occurrence, invoice representation, and ledger posting retain distinct identities. | Temporal bindings are checked. General temporal selectors, cross-output contracts, occurrence/effect realization, and neutral perspective declarations remain independently scoped. |

#79 and #80 may be implemented and verified in parallel after their imported packages' contracts are frozen. Neither needs to depend on the other merely because both mention Party or time. Declare every directly imported package in the package manifest and contract dependency list. Do not add dependencies on issue numbers that are not package slugs; #30 is `entitlement`, not an `obligation` package.

The checked ConceptIR model composes explicit temporal axes (#75), carrier relationship validity (#77), optional effect timing (#76), and time-sensitive contracts (#74). Neutral perspectives (#78) preserve one authoritative fact. The ten-scenario REA-inspired corpus (#81) checks their combined modeling without claiming ISO conformance or automatic runtime enforcement. Package-owned handoff/publication behavior remains independently tested.

## Required contract tests

For #79, use leased equipment, consigned inventory, and a cloud resource with distinct owner/controller/custodian/operator/host or payer Parties. Assert that no relationship implies another and that domain-defined kinds require no compiler enum change. A custody handoff must publish an end/start pair coherently, retain one causal source identity, reject incompatible concurrent handoffs, and replay without duplicate custody. Backdated assertions and later terminations must produce different answers at earlier and later knowledge times. Test tenant isolation, inaccessible evidence, and unsealed candidate exclusion. Allocation must not itself confer ownership or custody.

For #80, exercise a commerce payment, reimbursement, and a non-money service credit. Materialize only the amount supported by the referenced obligation and reviewed fulfillment condition. Settle one position with multiple events and one event across multiple positions; reject cross-unit/currency allocation, duplicate application, over-settlement, and concurrent double-spending. Reversal is an append-oriented contribution that restores the correct open amount without deleting the original. Preserve the original knowledge-time answer after a late materialization, settlement, or correction.

Both creditor and debtor views must refer to the same position identity; receivable/payable is derived from the observing Party. An unrelated or unauthorized viewer must not gain access by choosing a perspective. Invoice and ledger bridges must reference the position/contribution rather than becoming its authority, and must not create a second occurrence to represent a projection update. A denied or failed bridge must leave a replayable durable state with no duplicate posting on retry.

Use the generated consumer bundles for these tests, with explicit typed links to domain records and separate SQLite/PostgreSQL stores. Package tests should exercise real Engine authorization and durable commit boundaries, including raw malformed candidates and interleaved writers. A pure reducer or mock bridge cannot certify provider durability or cross-package wiring.

## Verification and acceptance bookkeeping

The shared integration owner must update these files together:

- `specs/foundation/scope.json`: add #79/#80 with their agreed slugs/layers.
- `specs/foundation/dependencies.json`: direct package dependencies, owned gates, and `deferredIntegrationAcceptance` IDs for undelivered ConceptIR/application integration criteria.
- `specs/foundation/substrates.json` and `systems.json`: preserve exact catalog/contract agreement for the chosen layers.
- Each package's `forge.toml`, lockfile, `contract.json`, `verification.json`, documentation, and independent typed consumer fixture.
- Runtime exports and tests where the package service is shipped. Include cross-package suites in the relevant verifier descriptors; merely naming a file as evidence does not execute it.

Keep local runtime acceptance, compiler semantic acceptance, hosted provider durability, and application adoption separate. A deferred criterion retains its non-passing status; readiness may explicitly defer it without claiming completion. #75/#77 integration acceptance and the corresponding issue closure cannot be inferred from #79 package tests. The same rule applies to #74/#76/#78 and #80.

Hosted certification is profile-driven in `conformance/foundation/providers/profiles.json`. Adding packages to the scope does not automatically add hosted profiles or exercise new concurrency traces. Add explicit trace names and criterion IDs if expanding certification; otherwise state that existing provider profiles cover only their existing scopes. Do not preserve a hard-coded prior cell count when the profile set changes.

`foundation-state.mjs` fingerprints the package dependency closure plus all runtime source/tests, scripts, and compiler trees. New runtime/tests therefore invalidate previous local receipts broadly. Provider/app fingerprints and artifact checks likewise require fresh source-bound evidence where inputs change. Freeze shared verifier, manifests, package sources, and tests before final receipts; never carry forward a green receipt from different bytes.

## Standards and closure boundary

#81 is a validation exercise, not a new Foundation runtime package or an REA dependency. It requires ten scenarios and a primitive/relationship/composition/derived classification with provenance. Distinguish statements verified against the normative ISO standard from REA literature and Forge generalizations. This audit did not inspect the normative standard and makes no ISO-conformance claim.

Passing #79/#80 package tests establishes only the behavior their concrete traces exercise. The unresolved ConceptIR semantics and deferred application integrations remain visible follow-up acceptance, rather than being silently counted as delivered.
