import { Effect } from "effect";
import { createNodeHost } from "@forgegraph/runtime/node";
import {
  MemoryStorage,
  defineFunction,
  err,
  type AppBundle,
} from "@forgegraph/runtime";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
const token = process.env.RUNTIME_TOKEN;
if (!token || token.length < 32) throw Error("RUNTIME_TOKEN is required");
const bundle = JSON.parse(
  readFileSync(process.env.BUNDLE_PATH || "/app/app.json", "utf8"),
) as AppBundle;
const functions = [
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
const host = createNodeHost({
  bundle,
  store: new MemoryStorage(),
  cursorSecret: token,
  functions,
  sweepIntervalMs: 0,
  telemetryFormat: "silent",
  auth: {
    scheme: "bearer",
    async authenticate(request) {
      const actual = Buffer.from(request.headers.get("authorization") || ""),
        expected = Buffer.from(`Bearer ${token}`);
      return actual.length === expected.length &&
        timingSafeEqual(actual, expected)
        ? {
            tenant: "playground",
            actor: "console-operator",
            purposes: ["CustomerSupport"],
          }
        : err("Unauthenticated", "Runtime credential required");
    },
  },
});
await host.listen(8080, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void host.stop().then(() => process.exit(0)));
