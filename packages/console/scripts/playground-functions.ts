import { Effect } from "effect";
import { defineFunction } from "@forgegraph/runtime";
export const functions = [
  defineFunction("@demo/support-playground/_/EstimateSupport", ({ input }) => {
    const v = input as { hours: number; urgent: boolean };
    const rate = v.urgent ? 150 : 100;
    return Effect.succeed({
      hours: v.hours,
      hourlyRate: rate,
      total: v.hours * rate,
      currency: "USD",
    });
  }),
  defineFunction(
    "@demo/support-playground/_/ValidateContact",
    ({ input, fail }) => {
      const v = input as { email: string; message: string };
      return v.message.trim().length < 10
        ? fail("MessageTooShort", "Please include at least 10 characters.")
        : Effect.succeed({ accepted: true, messageLength: v.message.length });
    },
  ),
];
