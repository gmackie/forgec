# ConceptIR cross-domain validation corpus (#69)

Ten independently modeled domain slices stress the six existing kernel kinds: Entity, Fact, Process, External, Principal and Policy. These are executable contract fixtures, not full runtime applications. Each domain narrative includes mature application pressures; each questions file records where the representation falls short. No new primitive or source grammar is proposed.

Run:

```sh
cargo test -p forgegraph-semantic --test concept_corpus
```

The test loads all ten contracts, validates ownership completeness and references, checks canonical bytes, checks generated graph views, exercises semantic/invalid mutations and compiles both partial realization signatures. Runtime profiles, provider targets and HTTP routing change DomainIR identity while leaving the projected ConceptIR identity unchanged. These executable substitutions cover the available legacy projection; the architectural sketches do not prove full application equivalence.

To deliberately refresh canonical JSON and graph snapshots after editing a fixture:

```sh
UPDATE_CONCEPT_CORPUS=1 cargo test -p forgegraph-semantic --test concept_corpus
```

Review the resulting diff. Normal tests never rewrite artifacts. `concept-ir.json` is directly authored; no fictitious L0 source grammar is used. Mutation files are small test operations (replace/remove, moveOwner/duplicateOwner, checkProjection, substituteTransport), not an API or a general patch format.

## Coverage and admission

[coverage.json](coverage.json) maps every required axis to a checked JSON Pointer and either representation evidence or a stated limitation. A gap means the fixture exercises the pressure without claiming that the current algebra can enforce it. A represented row is still not a runtime proof. The suite checks minimum counts for external boundaries, security/classification, temporal selections and long-lived behavior. It requires every durable Entity and Fact to have exactly one authoritative producer.

| Domain | Main pressure | Explicit gap |
| --- | --- | --- |
| Commerce | Partial shipments/refunds and compensating authority | Money/quantity bounds and compensation order |
| Banking | Ledger facts, reconciliation and as-of balance | Balanced atomic posting and bitemporal correction |
| Hospital | Treatment ABAC, care waits and emergency access | Break-glass audit coupling and information flow |
| Manufacturing | Telemetry windows and batch quality | Event-time, late arrivals and retractions |
| Airline | Fan-in, feasibility results and human approval | Result-port links and optimization constraints |
| Configurable SaaS | Runtime metadata and dynamic records | Dependent payload validation and safe interpretation |
| Insurance | Loss-time coverage, evidence and reopen | Provenance completeness and validity intervals |
| Benefits | Versioned rules, appeals and retroactive awards | Bitemporal selection and legally adequate notice |
| Marketplace | Reactive keyed dispatch and proximity | Key isolation, exclusive matching and distance semantics |
| Collaboration | Offline/concurrent edits with one owner | Convergence, inheritance and revocation |

## Findings across domains

* Non-durable results fit Shape-typed process returns (airline, marketplace), but connecting a particular result port needs a relation. This is insufficient evidence to promote Value.
* Unique invariants cannot express balanced journals, refund ceilings or exclusive assignments. Banking, commerce and marketplace supply cross-domain evidence for evaluating a composable invariant contract with an actual checker.
* Digest/version references make provenance meaningful in insurance, hospital and benefits; completeness and audit obligations remain separate from identity.
* AsOf/during plus validity fields preserve intent but do not prove bitemporal joins (banking, insurance, benefits) or event-time window policies (manufacturing, marketplace).
* Proposals, approvals and evidence remain domain entities/facts/processes. Wait correlation and authorization-to-output coupling are the missing enforcement, not new industry primitives.
* Runtime-defined SaaS metadata is data interpreted by a static platform; it must not silently expand the compiled graph for every tenant.
* Collaborative ownership survives concurrent mutation structurally. CRDT/OT substitution is conditional on equal business conflict semantics, not assumed from a stack label.

Promotion order remains relationship → facet → pattern → domain wrapper → primitive. Any future primitive needs recurrence, demonstrated loss through composition, stakeholder-readable meaning, semantic substitution evidence and a concrete compiler/tooling consumer. This corpus intentionally does not freeze the kernel.
