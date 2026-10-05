# Opt-in ConceptIR business semantics

ConceptIR accepts an optional `semantics` object. Empty semantics are omitted, preserving existing canonical JSON. All named maps use sorted keys; changes participate in semantic hashes and `forgec concept diff`. The legacy projection derives valid-time bindings from `@effectiveDated` and retains the synthesized effectiveFrom/effectiveUntil fields because they express business time. Non-overlap storage enforcement remains in DomainIR.

`temporal` maps Entity/Fact identities to occurrence fields and half-open valid/knowledge intervals. Starts are required date/datetime fields; interval ends may be optional (open ended). Both endpoints must share a temporal type: calendar `date` is distinct from `datetime`/`timestamp` instants; no timezone or midnight conversion is inferred. These bindings describe meaning; they neither create history storage nor enforce interval ordering at runtime.

`selections` are named, typed bindings to a process input or policy resource. Each specifies one occurrence/valid/knowledge axis and an `at`, `during`, or `latest` relation. Bounds reference typed time values in the owning context and must match the selected axis, including both bounds of `during`. Latest requires distinct, required, orderable scalar tie-breaking fields including an immutable, nonnullable identity field. A retroactive correction can preserve the same business identity and valid time while changing knowledge time. Physical insertion order is never inferred.

`contracts` are named requires/ensures/invariant predicates owned by a Process, Entity, or Fact. Data owners support invariants only. Input port names are available to process preconditions; output ports are additionally available to postconditions. Data invariants use `self`. Temporal selector references must belong to that process or data target. The restricted expression subset supports typed boolean/comparison/arithmetic expressions and count/sum over collections. Unknown names, unsupported calls, mismatched operands and non-boolean predicates fail validation. Percentage literals are rejected along with percentage fields until unit-aware semantics are defined. Date/instant comparisons require matching temporal types. Nullable values and richer quantities/units need explicit future expression support; this is not a theorem prover or an ABAC replacement.

Contract identity normalizes `and`/`&&`, `or`/`||`, `not`/`!`, and equivalent integer/decimal spellings recursively. Decimal normalization preserves exact digits and keeps extreme exponents compact; it does not round through floating point or perform algebraic rewrites. Concept loading, hashing, semantic diff, registry definition digests and assurance claim hashes share this representation. Use `Contract::content_hash()` to bind a claim. Previously issued evidence for noncanonical spellings must be regenerated. Process contracts and applicability expressions use process ports only; policy attributes cannot leak through a colliding identifier. Temporal selector contexts that name both a process and a policy are rejected as ambiguous.

`invariant_producers()` reports the authoritative process owners already established by durable produce/emit outputs. Cross-output contracts make no physical transaction assumption.

Assurance is a separate L1 sidecar bound to the concept hash and each contract hash. It records declared staticallyProven/runtimeEnforced/externallyAssumed/observed/unknown status, implementation mechanism and evidence references. `check_assurance` checks binding and completeness only: a claim with an evidence identifier is not verified proof. `check_realization` remains fail-closed and reports unproven business requirements that legacy compiler evidence cannot establish. Changing a storage or execution strategy does not change ConceptIR.

`relationships` define domain-named roles with typed endpoints. Structural edges have no carrier or field binding. Reified relationships bind each role to a typed field on a declared Entity/Fact; additional quantity, status and lifecycle fields belong to that carrier; the relationship evidence set names supporting declarations. Temporal bindings attach to the same carrier. A `principal` ConceptType allows typed Principal → Party representation. No untyped relatedTo or universal entity reference is introduced.

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

## Subject profiles and observed Interaction realization

`semantics.subjects` maps a semantic ID to `{carrier, profiles}`. The carrier must be a declared Entity with at most one Subject declaration. Nonempty domain-owned profiles describe Party, software-agent, service, device, or other actor semantics through composition; they do not introduce inheritance or an untyped universal reference. Typed relationship endpoints can use Subject carriers for participation, delegation, qualification, obligations, responsibility, and attestation issuer/subject roles. Existing expression typing resolves the carrier's declared fields.

`semantics.representations` maps a semantic ID to `{relationship, principalRole, subjectRole, scopeRoles}`. The carried relationship must bind a declared Principal and a declared Subject carrier through distinct roles. Optional scope roles must be separate typed endpoints. Ordinary relationship validation checks all carrier-field bindings. These declarations explain representation; they grant no authority and do not automatically change ABAC decisions.

`ConceptIR::check_engagement_snapshot` and `forgec concept check-engagements <concept> <snapshot>` check normalized observed records. Engagement records name an interaction declaration, identity, epoch-millisecond start/end bounds, and optional parent identity. Event and process membership tuples name the record ID, declaration, and engagement ID. The validator rejects unknown declarations, reversed intervals, missing/wrong-type parents, parent cycles, duplicate membership tuples, and membership without a matching declared binding. A process may span multiple engagements. Validation is limited to the supplied snapshot; storage completeness, authorization, and write enforcement are adapter responsibilities. It does not turn an assertion of runtime enforcement into proof.

The compiled Foundation integration test adds domain-owned Engagement/Membership resources with typed links to the unchanged Foundation Participation package, then validates their authored L0 facets. This tests composition and semantic closure; it does not claim that compiler projection infers Subject profiles or Interaction semantics automatically.

## External constraints

`semantics.externalConstraints` distinguishes requirements imposed by an external authority from ordinary internal contracts and request-time policies. Each entry declares an authority Subject with an `authority` profile, a jurisdiction Entity, source citations, a typed applicability predicate and process context, required business contracts, prohibited processes, epoch-millisecond validity bounds, superseded constraint IDs, and optional evidence Entity/Fact references.

Applicability is a boolean expression checked in its declared process's input scope. It is a condition under which obligations apply, not an unconditional Requires contract or an authorization grant. Requirements reference existing typed business contracts; prohibitions identify processes. Validation rejects unknown references, missing citations, empty effects, malformed predicates, reversed/empty intervals, backwards revision starts, and supersession cycles with `E-L0-EXTERNAL-CONSTRAINT` diagnostics. Ordinary internal contracts remain internal unless an external constraint explicitly references them.

`external_constraints_for(process, at)` and `forgec concept explain-constraints <model> <process> --at <epoch-ms>` explain time-effective process requirements/prohibitions with authority, jurisdiction, citations, and the unevaluated applicability predicate. Entity/Fact invariants remain visible through the constraint and graph rather than being implicitly attributed to a process. Supersession preserves history; effective bounds remain explicit. Neither inspection nor graph export evaluates applicability or proves external authority, legal compliance, or runtime enforcement. L1 mechanism changes do not enter these declarations or their hash.

## Traceability requirements

`semantics.traceability` maps an ID to a source/destination Entity or Fact, an ordered path of `{relationship, fromRole, toRole}` hops, `requiredBy` ExternalConstraint, typed process-context `applicability`, effective interval, optional positive `retentionDays`, required endpoint attributes, and `validTime`/`knowledgeTime` flags. Relationships must connect consecutive typed endpoints. Required attributes must be declared fields on path endpoints; required temporal axes must exist on those endpoint declarations. The external constraint preserves source authority and citation provenance. Invalid contracts report `E-L0-TRACEABILITY`.

`check_trace_witness` binds supplied reconstruction evidence to the ConceptIR hash and requirement. It checks every ordered record/link against the typed path, field-presence obligations, observed retention bounds, temporal intervals, and effective time. Link role bindings must connect the consecutive record IDs. Failures report `E-L0-TRACE-WITNESS`; the CLI exposes the same checker through `concept check-trace`. This is a finite evidence check, not automatic retention enforcement or a proof of evidence authenticity. Applicability is not evaluated by witness checking.

Lineage graphs and evidence journals are independent L1 realization strategies illustrated by `examples/concept/traceability`. Neither storage layout nor mechanism enters the L0 identity. These declarations are requirements to reconstruct a chain; they do not themselves provide the chain or evidence.

### Required actor roles

A relationship may declare `subjectRoles`, a set of endpoint role names. Every named
role must exist and target a declared Subject carrier; failures report `E-L0-SUBJECT`.
Omitting the set preserves ordinary typed relationships, including non-actor resource
and evidence endpoints. This does not turn every Entity into an actor or grant authority.

`examples/concept/interactions/subject-roles.json` demonstrates a Party profile, a
software-agent Subject, a distinct service Principal, scoped representation, delegator/
delegate roles and attestation issuer/subject roles. The Delegation and Attestation
packages each retain a `fixtures/subject-semantics.json` overlay checked against their
actual generated bundles. These authored overlays declare meaning; projection does
not infer actor roles from names. The legacy Party package's text principal locator
remains an L1 identifier and is not itself a typed L0 representation declaration.

### Participant views and external representations

A perspective observer must be an Entity participant, never an authentication Principal.
Credential fields are rejected with a credential-specific diagnostic. A projected field's
purpose must match the view's purpose; purpose-bound policies must agree as well.
`ConceptIR::perspective_fields` exposes the filtered schema while preserving each source
field's classification and purpose metadata. This is inspection, not an authorization grant.

`business-semantics/cross-company.json` declares organizations behind the participating
Parties, one neutral SettlementPosition and purpose/policy-bound Receivable/Payable views.
The Integration consumer demonstrates a second composition: seller sales documents and
buyer purchase documents each use real `integration.ExternalMapping` records and typed
`TransferDocument` links to one `NeutralTransfer`. Runtime tests reject outsiders and
cross-tenant references. Company identity is distinct from the collaboration's storage
tenant; this does not authorize cross-tenant database access.


## Legacy temporal selections and realization diagnostics

`Selection.during` and `Selection.as_of` are retained as legacy/partial projection
metadata. New authored temporal requirements use `semantics.selections`, which
names an axis and typed input binding and requires deterministic latest ordering.
No axis is inferred for legacy fields; realization checking reports them as
unproven. This preserves existing artifacts without treating ambiguous legacy
metadata as a new temporal contract.

Missing business realization evidence is reported per declaration under
`/semantics/contracts/<id>` (and the corresponding temporal/effect families),
not collapsed into one opaque `/semantics` diagnostic. `E-L0-RELATIONSHIP`
rejects insufficient endpoint arity, unknown carriers/targets, mismatched bound
field types, and unknown evidence declarations. Validity belongs to a reified
carrier's temporal facet; structural edges without a carrier have no independent
lifecycle. Relationship `evidence` names supporting declarations; assertion-level
provenance, timestamps and quantities belong to the carrier or typed evidence
records. No proof authenticity is inferred from the evidence set.

See `examples/concept/business-semantics/rea-validation.md` for finite instance
scenarios, typed inventory effects and distinct SQL/Dynamo plan evidence.
