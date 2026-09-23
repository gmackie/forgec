# ConceptIR validation corpus

Status: proposed. Tracks #24.

## Purpose

ConceptIR should be stress-tested against mature, ugly applications before its
kernel or source grammar is frozen.

The validation target is not "can Forge draw a diagram for this domain?" It is:

1. Can the application be described with the small L0 kernel?
2. Can complexity be absorbed through composition, facets, patterns, relations,
   and domain concepts rather than new primitive node kinds?
3. Can the same L0 contract admit materially different L1 realizations?
4. Can Forge distinguish semantic changes from realization-only changes?
5. Does the resulting L0 remain readable when the application becomes fully
   featured rather than remaining a toy example?

The initial corpus contains ten applications chosen because they disagree about
what "normal business software" looks like.

## Corpus

### 1. Commerce: order, fulfillment, returns, and payments

Representative concepts:

~~~text
Customer
Cart
PriceBook
Promotion
InventoryPosition
Order
Payment
Shipment
Return
Refund
~~~

Representative facts:

~~~text
OrderPlaced
PaymentAuthorized
PaymentCaptured
InventoryAllocated
ShipmentCreated
ShipmentDelivered
CancellationRequested
ReturnReceived
RefundIssued
ChargebackOpened
~~~

Stress areas:

- multiple downstream consumers of Order and Payment facts;
- partial shipment and partial refund;
- backorder and substitution;
- cancellation after fulfillment begins;
- compensation and reversal;
- tax and pricing recalculation;
- one logical producer for Order despite many business inputs;
- customer/merchant/support ABAC;
- external payment, tax, shipping, and inventory systems.

Primary question:

> Can a fully featured commerce system avoid devolving into many features
> directly mutating Order?

Expected composition:

~~~text
PaymentAuthorized ──────┐
ShipmentCreated ─────────┤
RefundIssued ────────────┼──► MaintainOrder ──► Order
CancellationRequested ──┘
~~~

### 2. Banking: card authorization, ledger, settlement, and disputes

Representative concepts:

~~~text
Customer
Account
Card
Authorization
LedgerEntry
AccountBalance
Settlement
Dispute
~~~

Representative facts:

~~~text
AuthorizationRequested
AuthorizationApproved
AuthorizationDeclined
LedgerEntryPosted
SettlementReceived
ReversalReceived
ChargebackReceived
DisputeOpened
DisputeResolved
~~~

Stress areas:

- immutable financial facts versus current balances;
- double-entry invariants;
- point-in-time/as-of state;
- authorization versus posting versus settlement;
- reversals rather than destructive mutation;
- reconciliation across internal and external records;
- strong business correctness requirements without leaking database isolation
  vocabulary into L0;
- external card network and banking systems.

Questions this fixture should force:

- Is a business invariant a Process facet, Entity facet, Policy, or another
  composable concept?
- Is `asOf` sufficient or do some domains require richer bitemporal semantics?
- Can L1 prove that its consistency strategy is sufficient for an L0 invariant
  without L0 naming SERIALIZABLE/linearizable?

### 3. Hospital: clinical operations and patient care

Representative concepts:

~~~text
Patient
Encounter
CarePlan
MedicationOrder
LabOrder
LabResult
Observation
Transfer
BedAssignment
~~~

Representative facts:

~~~text
PatientAdmitted
LabResultReceived
MedicationAdministered
PatientTransferred
ClinicalAlertRaised
EmergencyAccessUsed
~~~

Stress areas:

- highly classified data;
- principal + resource + purpose ABAC;
- treatment, billing, operations, research, and other purposes;
- provenance of external versus internal observations;
- point-in-time clinical state;
- human decisions and approvals;
- emergency/break-glass access;
- external labs, pharmacies, insurers, and health-information networks;
- durable workflows that may last days or weeks.

Questions:

- Is provenance a first-class semantic facet?
- How should exceptional authorization overrides compose with normal ABAC?
- Can information-flow checks remain understandable at this graph density?

### 4. Manufacturing: MES, quality, telemetry, and maintenance

Representative concepts:

~~~text
Plant
Line
Machine
WorkOrder
Batch
MaterialLot
MachineState
QualityState
MaintenanceOrder
~~~

Representative facts:

~~~text
WorkOrderStarted
TemperatureObserved
PressureObserved
MachineFaultObserved
ProcessExcursionDetected
QualityHoldPlaced
MaintenanceRequested
BatchCompleted
~~~

Stress areas:

- high-rate external observations;
- scheduled and event-driven ingestion;
- windows and derived state;
- batch/material genealogy;
- process/quality rules;
- current machine digital state;
- maintenance workflow;
- OPC UA / PLC / historian boundaries without leaking transports into L0.

Primary design pressure:

Do not let semantic selectors turn into a stream-processing language.

Prefer composition such as:

~~~text
TemperatureObserved
      ↓
CalculateTemperatureWindow
      ↓
TemperatureWindow
      ↓
DetectExcursion
      ↓
ProcessExcursionDetected
~~~

over continually extending `use` with moving-average/window/operator syntax.

### 5. Airline operations: disruption recovery / IROPS

Representative concepts:

~~~text
Flight
Aircraft
Crew
CrewDuty
Gate
PassengerConnection
MaintenanceStatus
WeatherState
AirportRestriction
ATCRestriction
RecoveryPlan
~~~

Representative facts:

~~~text
FlightDelayed
AircraftOutOfService
CrewUnavailable
GateUnavailable
WeatherChanged
ATCRestrictionIssued
RecoveryPlanApproved
~~~

Stress areas:

- extreme fan-in from independently owned Entities;
- many different activations for one business process;
- optimization/proposal generation;
- human approval before authoritative mutation;
- schedule and effective-time semantics;
- external weather, airport, maintenance, and ATC information;
- semantic intermediate results used to compress graph complexity.

Expected decomposition:

~~~text
Flight + Aircraft + Maintenance
          ↓
    FleetFeasibility

Crew + DutyRules
          ↓
    CrewFeasibility

Gate + AirportRestrictions
          ↓
    AirportFeasibility

Weather + ATC
          ↓
    AirspaceFeasibility

          ↓
     BuildRecoveryPlan
~~~

This fixture should help decide whether non-durable semantic `Value` belongs in
the ConceptIR kernel or should remain a typed process port/result.

### 6. Configurable SaaS / Salesforce-like meta-application

Representative concepts at the platform level:

~~~text
Tenant
ObjectDefinition
FieldDefinition
RelationshipDefinition
AutomationDefinition
PolicyDefinition
ViewDefinition
~~~

Stress areas:

- tenant-defined schemas;
- tenant-defined automations;
- runtime-defined metadata;
- custom fields and relationships;
- tenant isolation;
- generated CRUD;
- configurable ABAC;
- schema evolution.

Primary question:

> Where is the boundary between ConceptIR describing the compiled platform and
> runtime metadata describing a customer's application?

ConceptIR must not require a compiler-level Entity declaration for every
runtime-created tenant object.

This fixture exists specifically to prevent ConceptIR from assuming that all
domain schema is statically known.

### 7. Insurance: underwriting, claims, evidence, and payout

Representative concepts:

~~~text
Customer
Policy
Coverage
Claim
Loss
Claimant
Evidence
Estimate
Reserve
ClaimDecision
Payment
SubrogationCase
~~~

Representative facts:

~~~text
PolicyBound
LossReported
ClaimOpened
EvidenceReceived
EstimateCompleted
FraudSignalRaised
CoverageDetermined
ClaimApproved
ClaimDenied
PaymentIssued
ClaimReopened
~~~

Stress areas:

- policy state and coverage as-of loss time;
- long-lived case/workflow;
- documents, photos, estimates, and external evidence;
- adjuster and supervisor human decisions;
- fraud analysis;
- reserve updates;
- multiple payouts;
- reopen/reconsider rather than simple terminal completion;
- external repair shops, medical providers, police reports, catastrophe data;
- sensitive personal/financial/medical data.

Questions:

- Are blobs/documents merely typed data referenced by Entities/Facts, or is
  there missing L0 semantics around evidence?
- Does a long-running "case" require anything beyond Entity + Process +
  workflow/stateful facets?
- Can decision provenance explain why a claim was approved under the policy
  version in effect at the time of loss?

### 8. Government benefits / case management

Representative concepts:

~~~text
Person
Household
Application
EligibilityCase
Program
RuleSet
Evidence
BenefitAward
Payment
Appeal
~~~

Representative facts:

~~~text
ApplicationSubmitted
EvidenceReceived
EligibilityDetermined
BenefitAwarded
BenefitSuspended
RecertificationRequested
AppealFiled
AppealDecided
RetroactiveAdjustmentIssued
~~~

Stress areas:

- rules change over calendar time;
- effective dating and bitemporal corrections;
- household/relationship modeling;
- periodic recertification;
- evidence collection;
- notices and legally significant delivery;
- appeal/review workflows;
- retroactive corrections and payments;
- principal/purpose/agency ABAC;
- detailed audit/provenance requirements.

Primary pressure:

The system must explain:

> Which rule version, evidence, household state, and effective dates produced
> this decision?

This fixture should validate temporal lineage and policy-version semantics
without embedding a specific rules engine in ConceptIR.

### 9. Multi-sided marketplace / dispatch

Representative concepts:

~~~text
Customer
Provider
Vehicle
Job
Offer
Assignment
Location
PriceQuote
Trip
Payout
Rating
~~~

Representative facts:

~~~text
JobRequested
ProviderLocationObserved
OfferCreated
OfferAccepted
OfferExpired
AssignmentCreated
ProviderArrived
JobCompleted
JobCancelled
PayoutIssued
~~~

Stress areas:

- high-rate location observations;
- geospatial candidate selection;
- matching/ranking;
- offers to multiple providers;
- timers/expiry;
- dynamic price quotes;
- long-lived keyed dispatch/trip state;
- cancellation/rerouting;
- two-sided permissions and privacy;
- payout/reconciliation.

This fixture should contain at least one sub-scenario naturally modeled as
`@stateful` rather than as a linear workflow.

It also pressures the boundary between:

~~~text
semantic statement:
  eligible providers near the pickup

L1 realization:
  geospatial index / H3 / PostGIS / provider-specific query
~~~

### 10. Collaborative workspace / document application

Representative concepts:

~~~text
Workspace
Document
Block
Membership
Share
Comment
Version
Notification
~~~

Representative facts:

~~~text
DocumentCreated
DocumentEdited
CommentAdded
ShareGranted
ShareRevoked
VersionPublished
DocumentRestored
~~~

Stress areas:

- many concurrent writers;
- sharing/ABAC inherited through workspace/document hierarchy;
- comments and mentions;
- version history;
- offline edits;
- conflict resolution / CRDT or OT realization;
- realtime presence;
- notifications;
- audit/history;
- search and projections.

Primary question:

> Does the one-logical-producer rule still hold when many users concurrently
> edit one Entity?

Expected answer to test:

The users are not independent logical producers. They provide commands/facts to
the authoritative document-maintenance process. CRDT/OT/merge algorithms are
L1 realization mechanisms unless conflict semantics themselves are part of the
business contract.

This fixture exists specifically to challenge the producer invariant rather
than quietly exempt collaborative software from it.

## Coverage matrix

Legend:

- **P**: primary stress case
- **S**: significant secondary coverage
- **—**: not a focus

| Semantic pressure | Commerce | Banking | Hospital | MES | Airline | Config SaaS | Insurance | Benefits | Marketplace | Collaborative |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| multi-input derivation | S | S | P | S | P | S | P | P | P | S |
| single logical producer | P | P | S | P | S | P | S | S | P | P |
| request activation | P | P | S | S | S | P | S | P | P | P |
| fact/event activation | P | P | P | P | P | S | P | P | P | P |
| change activation | P | S | P | P | P | P | S | S | P | P |
| schedule activation | S | P | S | P | P | S | S | P | S | — |
| external acquisition | P | P | P | P | P | S | P | P | P | S |
| external export | P | P | P | S | S | S | P | P | P | S |
| workflow / long waits | P | S | P | S | S | S | P | P | S | — |
| keyed stateful behavior | S | — | S | S | S | S | S | S | P | P |
| temporal / as-of | S | P | P | S | P | S | P | P | S | P |
| effective dating | S | S | S | S | S | S | P | P | — | — |
| invariants | S | P | P | P | P | S | P | P | S | S |
| reconciliation / reversal | P | P | S | S | S | — | P | P | P | S |
| human-in-loop | S | S | P | S | P | P | P | P | S | P |
| ABAC / purpose | P | P | P | S | S | P | P | P | P | P |
| sensitive classification | P | P | P | S | S | P | P | P | P | P |
| emergency override | — | S | P | S | S | — | S | S | S | — |
| provenance / evidence | S | P | P | P | P | S | P | P | S | P |
| high-rate observation stream | — | P | S | P | S | — | S | — | P | P |
| runtime-defined schema | — | — | — | — | — | P | — | S | — | S |
| optimization / matching | S | S | S | S | P | — | S | S | P | — |
| geospatial semantics | S | — | S | P | P | — | S | S | P | — |
| concurrent mutation | S | P | S | P | P | P | S | S | P | P |
| documents / evidence / blobs | S | S | P | S | S | S | P | P | S | P |
| hierarchical inheritance | S | S | P | P | S | P | S | P | S | P |

A missing semantic pressure should be added to the matrix before adding another
application. Add an eleventh fixture only when the new application exercises an
important axis not credibly covered above.

## Standard fixture shape

Each application should eventually live under:

~~~text
examples/concept/<fixture>/
~~~

with a common structure:

~~~text
README.md
domain.md
concept.forge
concept-ir.json

views/
  overview.*
  ownership.*
  security.*
  external.*

realizations/
  realization-a/
  realization-b/

mutations/
  semantic/
  realization-only/
  invalid/

questions.md
~~~

The exact artifact formats may evolve with ConceptIR tooling. The important
parts are the roles.

### README.md

Scope and what the fixture is intended to stress.

### domain.md

Plain-language domain narrative and business rules. This is the source against
which stakeholder readability can be evaluated.

### concept.forge

Explicit L0 once source syntax exists.

Before source syntax is implemented, the fixture may use a canonical hand-built
ConceptIR JSON fixture.

### concept-ir.json

Canonical deterministic ConceptIR snapshot.

### views/

Generated/scoped graph snapshots. Layout is non-semantic.

### realizations/

At least two materially different L1 realization sketches or executable
fixtures for core scenarios where practical.

The purpose is to prove that L0 is not accidentally coupled to one runtime
topology.

### mutations/

Tests that deliberately change the model.

#### semantic/

Must produce an L0 diff.

Examples:

~~~text
90d -> 30d
all invoices -> open invoices
schedule -> fact activation
remove required purpose
change canonical producer
change external semantic source
~~~

#### realization-only/

Must not produce an L0 diff.

Examples:

~~~text
Postgres -> DynamoDB
queue -> direct invocation
cache TTL
index
batch size
fanout concurrency
provider binding
~~~

#### invalid/

Must fail realization or semantic validation.

Examples:

~~~text
two producers for one Entity
missing required ABAC enforcement
export classified data without required authority
L1 query cannot satisfy L0 temporal contract
workflow omits required business wait
~~~

### questions.md

Every fixture should record places where the current ConceptIR feels strained.

This is important. A fixture is successful when it discovers pressure, not when
authors hide awkwardness to make the current design look complete.

## Cross-fixture promotion rule

A modeling problem found in one fixture is not sufficient evidence for a new
kernel primitive.

Default response order:

~~~text
relationship
   ↓
facet
   ↓
pattern
   ↓
domain wrapper
   ↓
kernel primitive
~~~

Promotion toward the kernel should require:

1. the semantic distinction appears in multiple unrelated domains;
2. representing it through composition is materially awkward or lossy;
3. it passes the ConceptIR English test;
4. it passes the semantic-substitution test;
5. Forge can consume it for enforcement, diff, provenance, generation, or
   another concrete purpose.

This corpus exists to produce that evidence.

## Open questions the corpus should resolve

The examples should explicitly pressure these unresolved questions rather than
answering them prematurely in the kernel:

1. **Value** — do non-durable semantic intermediates such as
   `CrewFeasibility` deserve a first-class L0 `Value`, or are typed process
   ports/results sufficient?
2. **Invariant** — should business invariants be a facet, policy form, relation,
   or another composition?
3. **Provenance** — when does source/evidence lineage alter business meaning
   enough to be L0?
4. **Temporal model** — are `during`, `asOf`, and effective dating enough,
   or is a bitemporal semantic substrate needed?
5. **Decision/proposal** — is a proposed plan merely a Value/Entity plus
   approval process, or does it reveal another reusable pattern?
6. **Evidence/documents** — are blobs and documents just typed data references,
   or does evidence need domain-level semantics?
7. **Runtime metadata** — how does ConceptIR cleanly model a platform whose
   customers define new application schemas at runtime?
8. **Concurrent editing** — can the single-producer invariant remain universal
   while CRDT/OT lives entirely in L1?
9. **Streaming/window semantics** — where is the boundary between meaningful
   business windows and L1 stream processing?
10. **Optimization/matching** — what part of candidate generation/ranking is
    semantic versus replaceable algorithmic realization?

## Success criteria

The corpus succeeds if, after modeling all ten applications:

- the ConceptIR primitive kernel remains approximately the same size;
- most domain variation appears as Entities, Facts, Processes, relations,
  facets, patterns, and domain packages;
- the L0 graphs remain understandable at useful scoped views;
- each fixture can identify one logical producer for durable truth without
  inventing artificial ownership;
- L1 transport/storage/runtime details remain replaceable;
- semantic mutations are reliably distinguishable from realization-only
  mutations;
- difficult examples produce reusable patterns rather than a growing list of
  special-case node kinds;
- unresolved gaps are explicit.

The strongest signal that ConceptIR is working is not that every fixture looks
identical.

It is that radically different applications can be described by the same small
semantic algebra while retaining their domain-specific meaning.
