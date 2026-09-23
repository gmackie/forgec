# Opt-in ConceptIR business semantics

ConceptIR accepts an optional `semantics` object. Empty semantics are omitted, preserving existing canonical JSON. All named maps use sorted keys; changes participate in semantic hashes and `forgec concept diff`. The legacy projection derives valid-time bindings from `@effectiveDated` and retains the synthesized effectiveFrom/effectiveUntil fields because they express business time. Non-overlap storage enforcement remains in DomainIR.

`temporal` maps Entity/Fact identities to occurrence fields and half-open valid/knowledge intervals. Starts are required date/datetime fields; interval ends may be optional (open ended). Both endpoints must share a temporal type: calendar `date` is distinct from `datetime`/`timestamp` instants; no timezone or midnight conversion is inferred. These bindings describe meaning; they neither create history storage nor enforce interval ordering at runtime.

`selections` are named, typed bindings to a process input or policy resource. Each specifies one occurrence/valid/knowledge axis and an `at`, `during`, or `latest` relation. Bounds reference typed time values in the owning context and must match the selected axis, including both bounds of `during`. Latest requires distinct, required, orderable scalar tie-breaking fields including an immutable, nonnullable identity field. A retroactive correction can preserve the same business identity and valid time while changing knowledge time. Physical insertion order is never inferred.

`contracts` are named requires/ensures/invariant predicates owned by a Process, Entity, or Fact. Data owners support invariants only. Input port names are available to process preconditions; output ports are additionally available to postconditions. Data invariants use `self`. Temporal selector references must belong to that process or data target. The restricted expression subset supports typed boolean/comparison/arithmetic expressions and count/sum over collections. Unknown names, unsupported calls, mismatched operands and non-boolean predicates fail validation. Percentage literals are rejected along with percentage fields until unit-aware semantics are defined. Date/instant comparisons require matching temporal types. Nullable values and richer quantities/units need explicit future expression support; this is not a theorem prover or an ABAC replacement.

`invariant_producers()` reports the authoritative process owners already established by durable produce/emit outputs. Cross-output contracts make no physical transaction assumption.

Assurance is a separate L1 sidecar bound to the concept hash and each contract hash. It records declared staticallyProven/runtimeEnforced/externallyAssumed/observed/unknown status, implementation mechanism and evidence references. `check_assurance` checks binding and completeness only: a claim with an evidence identifier is not verified proof. `check_realization` remains fail-closed and reports unproven business requirements that legacy compiler evidence cannot establish. Changing a storage or execution strategy does not change ConceptIR.

`relationships` define domain-named roles with typed endpoints. Structural edges have no carrier or field binding. Reified relationships bind each role to a typed field on a declared Entity/Fact; all additional quantity, status, evidence and lifecycle fields belong to that carrier. Temporal bindings attach to the same carrier. A `principal` ConceptType allows typed Principal → Party representation. No untyped relatedTo or universal entity reference is introduced.

`events` identify occurrence Facts. `effects` identify distinct typed consequence Facts and bind their causal event fields and target fields to declared types. One event may cause multiple effects; repeated occurrences can contribute to the same target. Relationship carriers can be effect targets. Effects can carry typed quantities and time fields and participate in contracts. No event-sourcing, mutation-patch, or automatic state-update runtime is implied.

`views` derive participant perspectives from one neutral Entity/Fact identity. A view binds its observer role to a typed participant field, selects fields and references existing policies/purpose. Secret fields are rejected. Other classification and purpose metadata remains on the original field types. The declaration is not an authorization bypass: runtime projection must enforce these policies and field restrictions. That generated runtime bridge and external Integration mapping remain follow-up work.

These are explicit JSON contracts. New Forge surface syntax, complete semantic typechecking for every existing expression family, enforcement adapters, and full acceptance coverage for #74–78 remain outstanding. Use `forgec concept check`, `inspect`, and `diff` for declaration-level validation and review.

## Interaction contexts

`semantics.interactions` maps a semantic identity to an engagement contract:

- `carrier`: a declared Entity owning the engagement identity, with a valid-time interval in `semantics.temporal`.
- `participation`: carried relationship IDs with an endpoint to the carrier. Participant roles remain domain-defined relationship semantics.
- `events`: occurrence Fact ID to the required Entity-reference field identifying its engagement.
- `processes`: Process ID to the required Entity-reference input port identifying its engagement.
- `parent`: optional carrier field referencing a declared interaction carrier, permitting same-type or cross-type nesting.
- `purpose`: optional declared purpose.

An entity has at most one interaction declaration. Events and processes remain independent identities and can bind multiple engagement types through separate typed fields/ports. Carrier, participation, event, process, parent, temporal, and purpose mismatches report `E-L0-INTERACTION` (existing temporal and relationship validators also apply). Graphs expose interaction nodes and `participatesIn`, `occursIn`, `engagesIn`, and `parentInteraction` edges. Semantic hashes and diffs include the interaction contract; legacy models omit the new empty map and retain their encoding.

The model expresses business context, not runtime connection/session ownership. It introduces no untyped entity reference, domain inheritance, provider choice, or enforcement claim. Instance parent-cycle checks, actual interval ordering, and runtime realization remain outside this declaration validator. See `examples/concept/interactions` for six domain fixtures.
