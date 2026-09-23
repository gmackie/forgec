# Commerce: fulfillment and returns

A merchant accepts an order that can ship in several pieces. A customer can cancel the unshipped remainder, return a delivered portion, and receive several refunds. MaintainOrder alone owns Order; carrier delivery, customer cancellation and payment results are inputs to that authority, not competing writers. Fulfilled quantity must never exceed ordered quantity, and cumulative refunds must not exceed captured funds. Those arithmetic invariants are requirements, not currently enforceable ConceptIR Unique invariants.

ManageShipment waits for carrier delivery; ManageReturn waits for receipt; ManageRefund issues a compensating payment rather than erasing a charge. Payments, tax and shipping are separate business boundaries. Customer self-service, merchant operations and support share tenant restrictions; the support purpose does not itself grant access. Partial fulfillment and reversal amounts remain explicit data.
