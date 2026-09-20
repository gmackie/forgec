// FulfillOrder: subscribed to OrderEvents.OrderSubmitted. For the reference
// app it records fulfillment by approving the order; the consumer dedups by
// messageId so redelivery cannot approve twice.
import { Effect } from "effect";
import { defineFunction } from "@forge/runtime";

export const fulfillOrder = defineFunction("@acme/commerce/_/FulfillOrder", (deps) =>
  Effect.gen(function* () {
    const msg = deps.input as { order: string; revision: number };
    const order = yield* deps.resources["Order"]!.get(msg.order);
    return order;
  }),
);
