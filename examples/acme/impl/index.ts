import { authorizePayment } from "./payment-adapter.js";
import { fulfillOrder } from "./fulfill-order.js";
import { rebuildOrderSummary } from "./rebuild-order-summary.js";
import { submitOrder } from "./submit-order.js";

export const functions = [submitOrder, fulfillOrder, rebuildOrderSummary];
export const externals = { "@acme/payments/_/AuthorizePayment": authorizePayment };
