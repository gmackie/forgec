# Explicit business semantics

These linked #69 fixtures exercise the opt-in semantic declarations for #74–78. They are design contracts, not deployed applications. Validate them with `forgec concept check <file>`; inspect graph/ownership with `forgec concept inspect <file>`, and compare versions with `forgec concept diff <before> <after>`.

| Fixture | Question represented | Contract and time distinction |
| --- | --- | --- |
| commerce | How much of a position has been settled, and for whom? | applied ≤ amount; one position supports creditor/receivable and debtor/payable views |
| banking | Does posting preserve balanced outputs? | sum(debits) = sum(credits); transfer occurrence differs from knowledge of posting |
| manufacturing | How much inspected material may be released? | released ≤ inspected; inspection occurrence and release-effective time differ |
| configuration | Which approved changes did reconciliation apply? | appliedChanges ≤ approvedChanges; observation differs from its consequence |
| benefits | Was payment within the award known for that decision? | paid ≤ awarded; retroactive validFrom is distinct from knownFrom |
| insurance | Was a loss covered under the policy known at decision time? | paid ≤ covered; valid-at-loss and known-at-decision are separate selectors |
| hospital | Which ordered tests have completed? | completedTests ≤ orderedTests; specimen collection differs from receipt of the result |
| payroll | Does payment exceed earned compensation? | paid ≤ earned; retroactive employment changes preserve valid and knowledge axes |

All fixtures distinguish process inputs from durable outputs and name the invariant's producer. Temporal selectors bind a specific typed input, not a free-floating record type. These structural examples do not implement claims adjudication, healthcare decisions, money rounding, or histories. The existing larger domain corpus remains authoritative for domain narratives and mutation scenarios.

Commerce also models reciprocal obligations under an agreement, specification-constrained resources, reservations, partial fulfillment quantities on relationship facts, separate ownership/control/custody/operation assignments, quotes as ordinary entities, invoices as projected shapes, and purchase/sale as views. The semantic model deliberately has no Quote, Invoice, Receivable, or Duality primitive. A payment occurrence can cause both settlement and discharge effects; fulfillment effects target the same obligation across multiple deliveries.

## Standards provenance and remaining REA validation (#81)

The candidate mappings below are **Forge modeling choices inspired by REA literature**. No normative claim about ISO/IEC 15944-4:2015 has been verified here; these fixtures do not establish ISO conformance. A standards review and executable instance-level scenarios remain necessary before #81 is complete.

| Literature concept | Forge choice | Classification |
| --- | --- | --- |
| Economic agent | Party-shaped Entity | domain composition |
| Economic resource | Resource Entity with Specification reference | domain composition |
| Economic event | occurrence Fact plus typed consequences | semantic event/effect facet |
| Commitment / contract | Obligation / Agreement Entities | domain composition |
| Claim | outstanding SettlementPosition | derived position over obligations |
| Participation / custody / control | named typed relationship with carrier | relationship facet |
| Fulfillment | quantity on FulfillmentApplied | relationship + effect |
| Typification | Resource → Specification | typed relationship |
| Duality | reciprocal obligations under the same Agreement | derived; deliberately not primitive |
| Invoice / sale / purchase | shape / participant view | projection |

Non-economic validation includes configuration reconciliation and manufacturing release; the effect distinction does not depend on accounting. These are declaration checks, not proof that 400 + 300 + 300 units fulfill a 1,000-unit obligation or that $2,000 + $3,000 settle $5,000. That instance-level arithmetic and the complete ten-scenario REA corpus remain open.
