import { it, expect } from "vitest";
import { RuntimeConnection } from "../src/runtime-control.js";
it.skipIf(!process.env.PLAYGROUND_TEST_URL)(
  "invokes the compiled Forge demo and returns its declared business error",
  async () => {
    const runtime = new RuntimeConnection({
      id: "demo",
      name: "Demo",
      endpoint: process.env.PLAYGROUND_TEST_URL!,
      token: "local-playground-runtime-token-123456789",
    });
    const catalog = await runtime.catalog();
    expect(catalog.operations).toHaveLength(2);
    const estimate = catalog.operations.find((o) =>
      o.id.endsWith("/EstimateSupport"),
    )!;
    const result = await runtime.invoke({
      operationId: estimate.id,
      input: { hours: 2, urgent: true },
      buildHash: catalog.buildHash,
      purpose: "CustomerSupport",
    });
    expect(result.outcome).toMatchObject({
      kind: "ok",
      value: { total: 300, currency: "USD" },
    });
    const validate = catalog.operations.find((o) =>
      o.id.endsWith("/ValidateContact"),
    )!;
    const invalid = await runtime.invoke({
      operationId: validate.id,
      input: { email: "person@example.com", message: "short" },
      buildHash: catalog.buildHash,
    });
    expect(invalid.outcome).toMatchObject({
      kind: "error",
      problem: {
        code: "@demo/support-playground/_/ValidateContact.MessageTooShort",
      },
    });
  },
);
