# ConceptIR v2 contracts

`concept-ir/2` is the separate, partial L0 business-contract representation. DomainIR, planners, runtime bundles, editions 2026/2027, and their hashes are unchanged. No new source grammar is introduced.

Export an existing application:

```sh
forgec inspect examples/acme --concept > concept.json
```

The result contains `conceptHash`, `projection` (`concept`, `realizations`, `coverage`) and `graph`. This is an inspection artifact, not a runtime bundle or a signed registry layer.

## Representation

The Rust/Serde schema is `forgegraph_semantic::concept`. `ConceptIR::load` rejects unsupported versions, unknown ConceptIR fields, producer conflicts, invalid durable output kinds and undeclared principal/policy/external references. It does not yet validate every type, selection binding or ABAC predicate. It is not a policy enforcement engine.

The root has `version`, `package` (qualified name), and ID-keyed maps:

| Map | Meaning |
| --- | --- |
| entities | Durable current state, fields, lifecycle, subject/record context and existing static capability ceiling |
| facts | Immutable business occurrences; legacy message projections are explicitly marked as candidates |
| externals | Named business systems with data, events and accepted output contracts |
| principals | Named principal attribute contracts |
| policies | Principal, resource type, purpose, required attributes, permit/deny effect and existing Forge expression |
| processes | Activations, internal/external inputs, output dispositions, principal, purpose, authorization and behavior |
| purposes, dataClasses | Existing Forge catalog declarations, not a new classification taxonomy |
| shapes, enums | Referenced value structures and enum member names |

Fields preserve types, optionality, normalizers, constraints, default/derived values, immutability and catalog identities. Hidden/synthesized runtime fields are omitted. Entity reference, record, identity and status forms remain distinct. Enum wire values are realization details; member names are retained.

Process inputs have independent `origin`, `selection` and optional authorization. Selection contains `cardinality` (`one`, `optional`, `many`, `latest`, `unknown`), `forBinding`, predicate, `during`, and `asOf`. Activation variants are request, fact, change, external event and schedule. Outputs distinguish produceEntity, emitFact, return and export. Collection authorization distinguishes requireAll and filterVisible. Behavior has independent nullable `workflow` (`waits`), `stateMachine` (`entity`, `lifecycle`), and `stateful` (a ConceptType) slots. These facets can coexist on one Process; their order cannot change semantic identity. State-machine facets must reference a declared entity and match its lifecycle.

Only produceEntity and emitFact establish authoritative ownership. Two ports from one process do not constitute competing owners; two distinct processes do. Returning an entity record is not producing that entity.

## Identity and serialization

Concept declarations reuse qualified semantic IDs. Ports are keyed by `<process>#input:<name>`, `#output:<name>`, and `#activation:<name>`. Projected facts use `<legacy-contract>#fact:<message>`; this provisional namespace remains coupled to the legacy declaration identity. Renaming that contract is therefore an L0 identity change until explicit fact identities exist.

All graph collections are BTreeMap/BTreeSet values and serialize in lexical order. Struct fields serialize in the Rust schema's fixed order. Remaining vectors retain their stored order (for example, expression arguments and normalization sequences); canonicalization does not claim arbitrary vector permutations are semantically equivalent. SHA-256 is computed over compact UTF-8 serialization of ConceptIR alone. Coverage, realization links, graph export, paths, provider targets and package release version are excluded.

## Conservative legacy projection

Resources become entity candidates. Channel messages become fact candidates without delivery, distribution or queue configuration. Functions and workflows contribute typed signatures. An HTTP-exposed callable implies request activation, but HTTP methods and paths are omitted. Subscriptions supply fact activations; scheduled sources supply schedule activation. Workflow waits identify facts without copying the execution graph or concurrency strategy.

Capabilities and `uses`/`sends` describe permitted behavior, not proven dataflow. Projection does not invent producers, precise selections, external systems, principals or contextual ABAC. The coverage map explicitly reports these unknowns. Imported type/fact references can point outside the projected package; they are not guessed to be external business systems. Workflow wait order, branching, correlation and business significance remain unknown in this projection.

`realizations` links declarations and ports to source semantic anchors. For ports without an exact current source anchor, it points to the owning declaration. The graph exposes named data dependencies, activation and output edges with their port IDs; schedule/request payload details remain on the process. Scalar ports are represented in ConceptIR even when they have no graph node. Unloaded referenced nodes have kind `reference`.

## Checking and limits

`realization_report` checks a required ConceptIR against the supported projection of DomainIR. Unrelated top-level declarations are allowed; nested contracts are compared exactly. Diagnostics use escaped JSON Pointer paths. Known mismatches produce `E-L0-REALIZATION`; ownership, temporal selection, external acquisition, contextual authorization and other unsupported requirements produce `E-L0-UNPROVEN`. Workflow waits remain unproven even when candidate waits match. The report includes the projection coverage caveats. `is_satisfied()` requires both diagnostic lists to be empty, and the convenience `check_realization` combines both lists to fail closed.

This verifies declared structure against compiler evidence, not handwritten implementation behavior. An empty requirement catalog does not assert that no additional declarations may exist. Within a declared process or entity, nested additions remain mismatches; this is deliberately not a general variance/refinement engine.

Run an enforceable check using a standalone ConceptIR contract (the `projection.concept` portion of inspection output):

```sh
forgec inspect examples/acme --concept | jq '.projection.concept' > required-concept.json
forgec check examples/acme --concept-contract required-concept.json
```

The command emits a JSON report and exits 1 for either violated or unproven requirements. A freshly projected Acme contract includes candidate workflow waits, so checking it reports uncertainty rather than claiming implementation proof. Plain `check` remains unchanged; contract enforcement is opt-in through this flag.

Inspect a scoped graph without changing the contract or its hash:

```sh
forgec inspect examples/acme --concept --focus '@acme/commerce/_/Customer' --hops 2
forgec inspect examples/acme --concept --focus '@acme/commerce/_/Customer' --relations produce,emit
```

`Graph::scoped` derives a bounded undirected neighborhood using optional relation kinds. Graphs include principal, policy authorization, purpose and lifecycle transition relationships. Collection types retain their referenced data edges. CLI focus IDs must exist; library callers receive an empty graph for unknown IDs.

### Migration from v1

Version 1 is rejected explicitly. Re-export projected artifacts. For authored contracts, replace a tagged single behavior with the corresponding slot in the v2 behavior object and set the other slots to null; update `version` to `concept-ir/2`. For example, `{"kind":"workflow","waits":{}}` becomes `{"workflow":{"waits":{}},"stateMachine":null,"stateful":null}`. Recompute ConceptIR hashes after migration. DomainIR and runtime bundle formats are unchanged.

Tests include an Acme snapshot, governance catalog preservation, business waits, file-move stability, transport-only changes, producer conflicts, and a directly constructed ingestion contract with schedule/event activation, external acquisition, multiple inputs, contextual policy and authoritative output.

Remaining #24 work: explicit experimental source grammar, complete business dataflow and activation inference, authored port realization mappings, richer refinement checks, semantic compatibility UX, broader type/policy validation and Studio graph editing. The typed ingestion fixture demonstrates representation, not runtime ABAC enforcement or ingestion execution.
