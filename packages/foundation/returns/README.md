# Returns and Reverse Fulfillment

ReturnOrigin pins the original admitted Inventory issue, completed Fulfillment,
customer/supplier, optional issued Agreement and one dedicated return Entitlement.
Requests pin authorization and disposition decisions/options, inspection run,
quantity, intended disposition and remedy. Commerce, warranty, industrial material
and loan/reusable-asset profiles share these facts.

`Returns.authorize` validates the effective right and prebound approved decision,
then claims quantity against an exact origin journal head. Up to 128 partial
claims cannot exceed either issued quantity or the dedicated entitlement ceiling.
The grant belongs to one origin, preventing reuse across original issues. These
claims are conservative and irrevocable; authorizing a return does not itself
receive goods, refund money or replenish stock.

`receipt` requires a distinct admitted Inventory return of the exact authorized
item and quantity into supplier custody. `disposition` verifies the pinned
unquarantined inspection, accepted option and sealed evidence. Restocking needs an
admitted transfer from the return position to usable stock. Repair, scrap and
supplier-return dispositions link separate Fulfillment work; selecting one does
not assert that the work or destruction has already completed. Returned stock
remains visible in Inventory until its owning movement changes it.

`remedy` is independent: replacement requires separate complete Fulfillment;
credit requires an issued exact negative Billing charge in the original agreement
and matching currency; refund requires an independently settled reverse obligation
with the customer as creditor. Refund projections require the host's typed
SettlementAdmission verifier; this system never infers payment from a return or
from a credit note. Each disposition has one remedy and each replacement/credit/
refund position can be claimed once. A loan return can authorize no financial
remedy at all.

Use these consuming readers before acting on raw candidate rows. All quantities
are exact six-decimal values. Local memory/SQLite/PostgreSQL tests cover partial
limits, original agreement/fulfillment traceability, receipt custody, inspection,
restock, independently issued credit, completed replacement, profiles and isolation.
