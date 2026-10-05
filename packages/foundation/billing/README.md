# Billing

Billing composes issued Agreement terms, Pricing rates/adjustments and immutable Usage
sources into charge snapshots. It uses Pricing's exact six-decimal arithmetic: no floating
point, implicit FX or hidden rounding. Rates outside their effective interval and usage
outside the agreement period fail closed. Meter-rate bindings pin the measured dimension.
A usage event can be rated once; recurring rates have one atomic claim per period. One-off
charges use caller-supplied stable domain source keys within the period.

`Billing.rate` validates an active issued agreement and exact source references. A usage
correction racing rating aborts the atomic admission. Existing rated sources remain frozen:
later corrections require separately priced credits/adjustments. Staged Usage replacement
events cannot be billed as independent usage; domain adapters must admit a new traceable
measurement and credit the original. Generic period proration and jurisdiction-specific tax
engines are deliberately absent. Typed BillingProration and BillingTaxDetail consumers link
their calculation specification to signed Pricing adjustments.

A Bill holds 1–16 exact charges. `issue` atomically creates all exclusive charge claims and
a digest over the complete snapshot. Competing bills cannot issue the same charge. Staged
bill lines are inert; readers revalidate the digest, sources and every charge claim. Issued
records cannot be silently edited. A correction bill references an issued predecessor and
contains new adjustment charges; its totals may be negative. Publication retries can read
an existing issue, while a competing different bill fails its unique charge claims.

SaaS, utility and professional-service invoice resources are representations of BillIssued.
Issuance does not create obligations, materialize debt, settle positions or post ledger
entries. BillPosition explicitly associates multiple separately validated SettlementPositions.
`Billing.positions` delegates balances to Settlements; supply the application's
SettlementAdmission callback when reading books with economic events. That callback admits
independently observed performance/payment, never an invoice total. Settlement's ledger
association still validates a separately published Ledger posting.

Tests cover exact usage/fixed/one-off rating, unit/precision/duplicate rejection, credits,
tax/proration links, competing issuance, later usage correction, multiple obligation-backed
positions, independent materialization/payment, balanced ledger posting and association,
authorization and tenant isolation on memory, SQLite and PostgreSQL.
