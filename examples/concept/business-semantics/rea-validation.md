# Transaction corpus evidence

`rea-commerce.json` is a closed ConceptIR model linked to the #69 corpus.
`rea-scenarios.json` supplies one ordered, typed observation trace and ten
independently named scenario assertions. The Rust `rea_corpus` suite resolves
all references against the model, checks required fields, and evaluates exact
integer-unit arithmetic without floating-point money. It is a finite modeling
exercise, not a standards conformance certificate or a new REA runtime.

| Scenario | Executable evidence |
| --- | --- |
| Reciprocal sale | Opposed obligation Parties share one Agreement; delivery and payment retain distinct source identities |
| Partial fulfillment | 400 + 300 + 300 = 1,000 units on relationship carriers |
| Partial settlement | 2,000 + 3,000 = 5,000, with invoice balances 3,000 then zero |
| Multi-party exchange | Seller, buyer, finance, logistics, and warranty Parties have distinct identities |
| Neutral perspectives | Outbound/inbound, sale/purchase, and receivable/payable bind the same fact per pair |
| Control versus custody | Distinct ownership/controller/custodian/operator records refer to the same resource |
| Specification versus instance | An obligation's specification matches the concrete resource's specification |
| Reservation before fulfillment | Ordered observation trace puts reservation before delivery; typed links agree |
| Quote accepted into agreement | Quote and Order are ordinary Entities; acceptance links to the Agreement |
| Invoice projection | Invoice is a Shape over a neutral position; remaining amounts are calculated from settlement contributions |

`foundation-settlement.test.ts` additionally executes the exact 400/300/300 and
2,000/3,000 examples through generated Foundation consumer bundles, with real
admission/publication and over-fulfillment/over-settlement rejection on memory
and SQLite. Its named trace is also required by the hosted settlement profile;
a hosted claim requires a current receipt. The observation trace's ordering is
not a claim that the semantic compiler enforces an arbitrary workflow.

The model includes one transfer causing stock-decrease and stock-increase
Effects, an exchange-completion Effect with payment and delivery causes, a
contract owned by an Effect, and an explicit read process consuming both stock
Effects to return a status Shape. Status is not another occurrence. Tests reject
wrong effect targets and missing relationship evidence, and distinguish carrier,
endpoint, evidence, and validity changes in semantic diff.

## Mapping classification and provenance

The background is the REA family introduced by William E. McCarthy, “The REA
Accounting Model: A Generalized Framework for Accounting Systems in a Shared
Data Environment,” *The Accounting Review* 57(3), 1982, pp. 554–578. Later REA
terminology and ISO/IEC 15944-4 motivate the exercise. No normative ISO text or
conformance conditions were verified in this work. Each mapping below is a
Forge choice; the literature column identifies inspiration, not claimed exact
standard equivalence.

| Candidate | Forge mapping | Classification | Provenance |
| --- | --- | --- | --- |
| Economic agent | Party / Subject carrier | composition | REA literature inspiration → Forge domain choice; ISO normative unverified |
| Economic resource | Resource with Specification reference | composition | REA literature inspiration → Forge domain choice; ISO normative unverified |
| Economic event / stock flow | occurrence Fact + typed Effect | reusable semantic facets | REA literature inspiration → Forge generalization; ISO normative unverified |
| Commitment | Obligation | composition | later REA terminology → Forge Foundation choice; ISO normative unverified |
| Contract | Agreement with reciprocal obligations | composition | later REA terminology → Forge Foundation choice; ISO normative unverified |
| Claim | neutral SettlementPosition | derived business position | literature inspiration → Forge choice; ISO normative unverified |
| Participation | named participant roles | typed relationship | REA literature inspiration → Forge generalization; ISO normative unverified |
| Custody / control | separately reified Party–Resource roles | typed relationships | literature inspiration → Forge distinction; ISO normative unverified |
| Fulfillment | local quantity on FulfillmentApplied | relationship + Effect | literature inspiration → Forge composition; ISO normative unverified |
| Typification | resource/specification typed reference | relationship | later REA terminology → Forge choice; ISO normative unverified |
| Duality | derive reciprocity from one Agreement and opposed obligations | derived; deliberately not primitive | REA literature inspiration → Forge demotion; ISO normative unverified |
| Quote / Order | ordinary domain Entities | compositions | Forge modeling choice; no normative ISO claim |
| Invoice | Shape over position/contributions | projection | Forge modeling choice; no normative ISO claim |
| Purchase / Sale | participant views over Agreement | projections | Forge generalization; no normative ISO claim |
| Receivable / Payable | participant views over SettlementPosition | projections | Forge generalization; no normative ISO claim |

Configuration reconciliation, manufacturing release, benefits, insurance,
hospital, and payroll remain independent cross-domain fixtures. Their contract,
effect, and temporal declarations are checked by `business_semantics.rs`, so
accounting vocabulary is not a compiler dependency.

## Lower-level realization evidence

`realizations/` compiles a bounded-balance invariant, typed occurrence/effect
messages, explicit knowledge timestamps, and existing effective dating. The
planner emits distinct relational history/index structures and DynamoDB
partition/sort access plans for the same checked L0 declaration. The regression
changes actual target profiles and proves different DomainIR hashes with equal
ConceptIR hashes. It also flags missing enforcement evidence rather than
promoting matching declarations to verified proof.

This is stronger than changing an Assurance label, but is still planning and
binding evidence. Temporal runtime behavior is independently exercised in
Foundation resource-relations/settlement provider suites. The planner test alone
is not a proof that any arbitrary storage mechanism preserves every contract.
