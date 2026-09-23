# 0002 — ConceptIR: composition over ontology growth

Status: proposed (2026-09-22). Tracks [#24](https://github.com/gmackie/forgec/issues/24).

## Context

ForgeGraph is adding ConceptIR, an L0 business-semantic graph above the existing executable/domain model.

The goal is not to create another universal enterprise modeling language. The goal is to preserve a compact, compiler-checkable description of what a business application means while the executable realization beneath it grows in features, integrations, policies, workflows, projections, deployment targets, and operational concerns.

Mature business applications do not usually become difficult through raw entity count alone. Complexity grows through interactions between concerns:

- entities participate in more processes;
- processes acquire data from more sources;
- authorization depends on principal, resource, purpose, and environment attributes;
- workflows introduce waits, timers, compensation, and human decisions;
- integrations add events, synchronization, canonicalization, and failure modes;
- the same data feeds APIs, projections, analytics, automation, and external exports;
- compliance and data-classification rules cut across all of the above.

If independently modeled features introduce new special-purpose primitives and point-to-point behavior, the number of meaningful interactions grows superlinearly and can approach combinatorial growth. The system becomes difficult to explain, review, change, and verify even when each individual feature is locally simple.

ConceptIR therefore needs a deliberate complexity-control strategy.

## Decision

ConceptIR will use a small semantic kernel plus composition.

Initial kernel:

~~~text
Entity
Fact
Process
External
Principal
Policy
~~~

Existing shared concepts such as types, shapes, purposes, and Forge's data-classification taxonomy compose with the kernel rather than expanding it.

New behavior should be represented primarily through:

- composition of existing concepts;
- relationships between concepts;
- reusable facets that add orthogonal semantics;
- reusable patterns that compose primitives/facets into recognizable designs;
- domain packages that provide naming and constrained wrappers over generic primitives.

Prefer:

~~~text
Process
  + @workflow
  + @stateful
  + @scheduled
  + authorization facet
  + observability facet
~~~

over an ontology that continually adds peers such as:

~~~text
WorkflowProcess
ScheduledWorkflowProcess
StatefulWorkflowProcess
ApprovalWorkflowProcess
IntegrationProcess
DecisionProcess
HumanTaskProcess
...
~~~

The default response to a modeling gap is composition, not a new primitive.

## Prior art and failure modes

The point of reviewing prior art is not to dismiss modeling. Several approaches remain valuable precisely because they constrained what they try to model. ConceptIR should steal the durable lessons and avoid repeating the failure modes.

### UML / general software design modeling

UML demonstrated the value of explicit structure and behavior models, but broad modeling languages impose a large semantic and tooling surface. An empirical study surveying 3,785 developers challenged assumptions about how extensively software design models are used in practice:

- [On the use of software design models in software development practice](https://www.sciencedirect.com/science/article/pii/S0164121214001022)

Lesson:

> Do not require developers or stakeholders to learn a comprehensive meta-model in order to describe ordinary business behavior.

ConceptIR should contain only distinctions that materially alter business meaning.

### Model-Driven Engineering

MDE correctly recognized that models can support generation, validation, and portability. Recurring problems include tooling dependency, integration with the rest of software engineering, maintenance, and synchronization across artifacts. A recent interview-based study reports practitioners describing modeling as insufficiently integrated with surrounding engineering workflows and highlighting tool/version dependency problems:

- [Report from MDE practice: An interview-based evaluation of model-driven engineering uses](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0335461)

ConceptIR adopts the useful part of MDE — the model participates in compilation — while rejecting the requirement that detailed implementation itself live primarily in the modeling language.

~~~text
ConceptIR = semantic contract
L1        = replaceable executable realization
compiler  = verifies the relationship
~~~

not:

~~~text
model = entire implementation
~~~

### BPMN

BPMN is valuable when the problem is genuinely a business process: ordered activity, waits, decisions, timers, compensation, and human interaction.

Its weakness as a universal application model is that it naturally makes control flow the center of the world. Business applications also contain durable domain state, derived state, fact relationships, asynchronous ingestion, external acquisition, and processes better understood as dependency graphs.

BPMN diagram understandability also depends on controlling visual/cognitive complexity:

- [Verifying the understandability of BPMN diagrams](https://www.sciencedirect.com/science/article/pii/S0141938225002732)

ConceptIR therefore treats workflow semantics as a facet/pattern over Process, not as the foundational ontology for all behavior.

### DMN

DMN demonstrates that a constrained semantic dependency graph can be business-readable and executable. Its Decision Requirements Graph composes input data, decisions, and supporting knowledge.

- [OMG DMN overview](https://www.omg.org/dmn/)
- [DMN 1.5](https://www.omg.org/spec/DMN/1.5)

This is strong precedent for ConceptIR's preference for semantic dependency graphs. Forge should interoperate with specialized models such as DMN where they are appropriate instead of growing the ConceptIR kernel to absorb them.

### C4

C4 succeeded in part by deliberately narrowing its scope. Its FAQ explicitly says it focuses on static software structures and does not attempt to cover business processes, workflows, state machines, domain models, or data models.

- [C4 FAQ](https://c4model.com/faq)

The important lesson is view discipline.

ConceptIR should not have one canonical giant diagram. It should have one canonical semantic graph with many projections:

~~~text
graph around Customer
graph for AssessRisk
external integration view
purpose/security view
producer/ownership view
change-impact view
~~~

The graph is data. Diagrams are views.

### EventStorming

EventStorming succeeds at a semantic altitude close to what ConceptIR wants: domain experts can discuss meaningful facts such as OrderPlaced and PaymentReceived without first learning implementation architecture. It is explicitly a collaborative format for exploring complex business domains.

- [EventStorming](https://www.eventstorming.com/)

ConceptIR should preserve that accessibility while making the result durable and mechanically connected to implementation:

~~~text
domain conversation
      ↓
Entity / Fact / Process vocabulary
      ↓
ConceptIR
      ↓
checked L1 realization
      ↓
running software
~~~

### Low-code / model-driven application platforms

Low-code platforms demonstrate that executable models can reduce drift, but often by making the model inseparable from the platform.

Mendix describes its domain model as central to application architecture and its microflows as a visual way of expressing what would traditionally be textual program code:

- [Mendix domain model](https://docs.mendix.com/refguide10/domain-model/)
- [Mendix microflows](https://docs.mendix.com/refguide/microflows/)

Power Apps model-driven applications are centered on Dataverse tables, columns, and relationships; Microsoft's documentation states that model-driven apps can only be defined using Dataverse:

- [Power Apps model-driven data model](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/define-data-model-driven-app)

ConceptIR must not make this trade. The same business-semantic graph should be realizable with different runtimes, databases, languages, providers, integration mechanisms, and workflow engines.

### Salesforce automation

Salesforce provides a useful real-world warning about mature application complexity. Its architecture guidance defines dependency sprawl as the downstream graph of writes triggered by an initial operation and recommends a single primary automation entry point for an object as automation density grows:

- [Salesforce Architects: Record-Triggered Automation](https://architect.salesforce.com/docs/architect/decision-guides/guide/record-triggered)

This aligns with ConceptIR's proposed single-logical-producer invariant:

~~~text
producer(Entity) <= 1
producer(Fact)   <= 1
~~~

Instead of treating fragmented ownership as a best-practice problem discovered after an application becomes difficult to maintain, Forge should make ownership explicit and compiler-checkable.

## Complexity thesis

Feature growth becomes dangerous when every feature is allowed to connect directly to every other feature.

A naive application can drift toward:

~~~text
feature A writes Customer
feature B writes Customer
feature C listens to Customer
feature C writes Account
feature D listens to Customer + Account
feature E special-cases feature B
...
~~~

Local reasoning breaks because each new capability adds interaction edges to an already dense graph.

ConceptIR should make complexity scale through composition boundaries instead.

~~~text
CRM update ────────┐
Support change ────┼──► MaintainCustomer ──► Customer
Scheduled refresh ─┘
                                          │
                            ┌─────────────┼─────────────┐
                            ▼             ▼             ▼
                       AssessRisk    SegmentCustomer  BuildSummary
~~~

The system may have many activations and many consumers, while ownership remains simple:

~~~text
producer(Customer) = MaintainCustomer
~~~

Cross-cutting requirements should likewise compose orthogonally:

~~~text
AssessRisk
  + purpose FraudPrevention
  + ABAC policy
  + data-classification constraints
  + @workflow only if workflow semantics are required
~~~

rather than multiplying bespoke process kinds.

## Composition model

ConceptIR distinguishes four levels of reuse.

### 1. Primitive

A tiny set of irreducible semantic concepts.

~~~text
Entity
Fact
Process
External
Principal
Policy
~~~

Primitives should change rarely.

### 2. Facet

An orthogonal property or contract applied to an existing concept.

Examples:

~~~text
@workflow
@stateful
@stateMachine
@audited
@classified(...)
@authorized(...)
@observable(...)
~~~

A facet should not create a parallel ontology.

### 3. Pattern

A reusable composition of primitives and facets that captures a recurring design.

Examples:

~~~text
canonical ingestion
approval
reconciliation
saga
materialized projection
outbox
effective dating
hierarchy
CRUD lifecycle
~~~

Patterns may expand into multiple ConceptIR/L1 elements but retain a recognizable semantic identity.

### 4. Domain wrapper

An application or domain package may give a pattern a more useful local name and constrain its parameters.

~~~text
Healthcare.PatientIntake
Finance.LedgerReconciliation
Commerce.OrderApproval
~~~

These should usually be wrappers over shared abstractions rather than additions to the compiler kernel.

## Admission test for new L0 concepts

Every proposed ConceptIR primitive, relationship, selector, or facet must pass three tests.

### 1. English test

Can a domain stakeholder understand the distinction in coherent business language?

Good:

~~~text
Assess risk using transactions from the previous 90 days.
~~~

Questionable:

~~~text
Read through a cache with a five-minute TTL.
~~~

The first changes business meaning. The second usually describes implementation.

### 2. Semantic substitution test

Could two implementations differ in this property while still implementing the same business behavior?

If yes, the property is probably L1.

Normally below L0:

~~~text
PostgreSQL vs DynamoDB
queue vs direct invocation
cache TTL 2m vs 5m
fanout concurrency 16 vs 32
index selection
HTTP vs RPC
~~~

Normally in L0:

~~~text
90-day history vs 30-day history
all invoices vs open invoices
scheduled refresh vs reaction to a business fact
one canonical producer vs competing authoritative producers
authorization required vs not required
~~~

### 3. Enforcement test

Can Forge use the declaration to detect a meaningful implementation or architecture error?

Examples:

- a 30-day L1 query cannot satisfy a 90-day L0 semantic input;
- an Entity with two logical producers violates ownership;
- an external export carrying restricted data without required authorization can be rejected;
- an L1 implementation that removes required ABAC enforcement fails realization checking.

If a declaration cannot participate in validation, compatibility analysis, generation, provenance, or another concrete consumer, question whether it belongs in the canonical semantic model.

## Additional guardrails

### Composition over ontology growth

Before adding a primitive:

1. attempt to express the need as a relationship;
2. then as a facet;
3. then as a reusable pattern;
4. then as a domain wrapper;
5. only then consider extending the kernel.

A primitive requires evidence that composition is semantically inadequate across multiple domains.

### No implementation leakage by convenience

Do not promote an L1 concept into ConceptIR merely because it is easy to visualize or already exists in a provider.

Remain L1 by default:

~~~text
Channel
Queue
Actor
Mailbox
Cache
Index
Partition
Worker
Lambda
Durable Object
Topic
Table
Bucket
Retry policy
Concurrency limit
~~~

L0 may express the business semantics those mechanisms realize.

### No canvas as source of truth

ConceptIR is canonical structured data/source.

Visual diagrams are projections and may store non-semantic layout metadata separately.

Semantic identity must never depend on x/y coordinates, canvas grouping, display order, or file location.

This preserves ordinary engineering workflows:

~~~text
diff
review
merge
blame
search
refactor
automation
agent edits
~~~

### No giant canonical graph

Tooling should generate scoped views over one graph instead of attempting to show the entire application at once.

Useful views include:

~~~text
around Entity
process neighborhood
external boundary
producer ownership
purpose/ABAC
data classification flow
workflow behavior
change impact
package/module boundary
~~~

### No second source of truth

ConceptIR earns its maintenance cost only if Forge uses it.

The compiler/tooling should increasingly consume it for:

~~~text
realization checking
compatibility/diff
authorization validation
data-flow/governance validation
documentation
graph views
agent context
impact analysis
generation
~~~

A model that can silently drift away from production behavior is a failed ConceptIR implementation.

## L0/L1 relationship

The long-term invariant is:

~~~text
projectConcept(L1 realization) satisfies declared ConceptIR
~~~

L1 has freedom to change execution mechanics while preserving ConceptIR.

No normal L0 delta:

~~~text
cache 5m -> cache 2m
Postgres -> DynamoDB
queue -> workflow signal
Lambda -> Worker
~~~

Semantic changes that must surface:

~~~text
transactions during 90d -> 30d
scheduled activation -> event activation
remove required authorization
change canonical producer
~~~

This checked relationship is the key difference between ConceptIR and documentation-only modeling systems.

## Why the current landscape makes this more viable

Earlier model-driven approaches often tried to reduce the cost of writing implementation code by moving more implementation detail into models.

That trade is less compelling when implementation code can be generated and transformed cheaply by humans plus coding agents.

The scarce artifact is increasingly the semantic contract:

- what business truth exists;
- who owns it;
- what produces it;
- what activates behavior;
- what information behavior requires;
- why data is being used;
- who is authorized;
- what invariants must remain true;
- what counts as a semantic change.

ConceptIR should optimize for this scarcity.

A coding agent can generate multiple L1 realizations of:

~~~text
Customer + 90d Transactions + CreditReport
                 ↓
             AssessRisk
                 ↓
            CustomerRisk
~~~

The valuable part is that Forge can determine whether each candidate still means the same thing.

## Consequences

### Positive

- The stakeholder model stays small as implementation sophistication grows.
- Cross-cutting concerns compose instead of multiplying primitive types.
- Domain packages can become expressive without bloating the compiler.
- L0 can remain stable while infrastructure/runtime choices change.
- Semantic diffs become distinguishable from implementation diffs.
- Agents gain a compact, high-signal contract for generating/reviewing code.
- One-producer ownership and other architectural invariants become checkable.
- Many visual/documentation views can be generated from one canonical graph.

### Costs

- The compiler must maintain explicit L0/L1 realization mappings.
- Some features require discipline to keep out of L0 even when exposing them seems convenient.
- Pattern/facet composition needs strong diagnostics so abstraction does not merely hide complexity in inscrutable expansion.
- Not every legacy package can be projected into complete ConceptIR; uncertainty and partial coverage must be explicit.
- The team must resist solving isolated domain problems by extending the core ontology.

## Review checklist

Any PR adding or expanding ConceptIR should answer:

1. What business distinction is being represented?
2. Can a stakeholder explain it without implementation vocabulary?
3. Why can this not be represented as a relationship, facet, pattern, or domain wrapper?
4. Could two equivalent implementations choose different values for this property?
5. What compiler/tooling behavior consumes the new semantics?
6. Does this increase the primitive ontology or compose existing concepts?
7. What happens to the generated L0 graph for a fully featured application?
8. Does the change preserve projection of L1 back to the same semantic contract?
9. Has the concept been demonstrated across more than one domain before promotion to the kernel?
10. Could the addition create a new independent source of truth?

## Summary

ConceptIR is deliberately not an attempt to finally invent a universal business modeling language.

It is a small semantic contract layer designed for a world where application implementations become increasingly sophisticated and feature-rich.

The strategy for retaining control is:

~~~text
small kernel
    +
orthogonal facets
    +
composable patterns
    +
domain wrappers
    +
checked L1 realization
    =
controlled semantic complexity
~~~

When feature count grows, the answer should be richer composition rather than proportional growth in the ConceptIR ontology.

That constraint is foundational to ConceptIR's viability.
