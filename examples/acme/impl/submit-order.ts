// SubmitOrder: the one piece of Acme business logic the toolchain cannot derive.
// The runtime hands this body exactly the dependencies declared in
// orders/fulfillment.forge: Order (read + status.submit), Site (read),
// payments.AuthorizePayment, and permission to send OrderSubmitted to OrderEvents.
import { Effect } from "effect";
import { defineFunction } from "@forge/runtime";

export const submitOrder = defineFunction("@acme/commerce/_/SubmitOrder", (deps) =>
  Effect.gen(function* () {
    const input = deps.input as { order: string; expectedVersion: number };
    const order = yield* deps.resources["Order"]!.get(input.order);
    const site = yield* deps.resources["Site"]!.get(order["site"] as string);
    if (!site["enabled"]) return yield* deps.fail("SiteDisabled", `site ${site["code"]} is disabled`);
    const auth = yield* deps.external("@acme/payments/_/AuthorizePayment", { amount: order["total"], reference: order["id"] });
    if (!auth.ok) return yield* deps.fail(auth.code === "PaymentDeclined" ? "PaymentDeclined" : "PaymentUnavailable", auth.detail);
    const submitted = yield* deps.transitions["Order"]!["submit"]!(input.order, input.expectedVersion, {});
    yield* deps.send("OrderEvents", "OrderSubmitted", { order: submitted["id"], customer: submitted["customer"], revision: submitted["version"] });
    return submitted;
  }),
);
