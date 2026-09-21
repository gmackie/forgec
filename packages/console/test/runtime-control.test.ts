import { it, expect } from "vitest";
import { RuntimeConnection, sampleInput } from "../src/runtime-control.js";
const spec = {
  openapi: "3.1.0",
  paths: {
    "/quote": {
      post: {
        operationId: "Quote",
        "x-forge-kind": "function",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Input" },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Input: {
        type: "object",
        required: ["email", "quantity"],
        properties: {
          email: { type: "string", format: "email" },
          quantity: { type: "integer", minimum: 1 },
          note: { type: "string" },
        },
      },
    },
  },
};
it("generates bounded schema samples through local references", () => {
  expect(sampleInput({ $ref: "#/components/schemas/Input" }, spec)).toEqual({
    email: "person@example.com",
    quantity: 1,
  });
  expect(
    sampleInput(
      { $ref: "#/components/schemas/Loop" },
      {
        components: {
          schemas: { Loop: { $ref: "#/components/schemas/Loop" } },
        },
      },
    ),
  ).toBeNull();
});
it("discovers functions, guards the observed build and invokes with server-only credentials", async () => {
  const requests: Request[] = [];
  let build = "one";
  const runtime = new RuntimeConnection(
    {
      id: "demo",
      name: "Demo",
      endpoint: "https://demo.example",
      token: "private-runtime-token",
    },
    async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      if (req.url.endsWith("/forge/discovery"))
        return Response.json({
          buildHash: build,
          features: ["invocation-preconditions"],
        });
      if (req.url.endsWith("/forge/openapi.json")) return Response.json(spec);
      return Response.json({ total: 24 });
    },
  );
  const catalog = await runtime.catalog();
  expect(catalog.operations[0]?.sample).toEqual({
    email: "person@example.com",
    quantity: 1,
  });
  const result = await runtime.invoke({
    operationId: "Quote",
    input: { quantity: 2 },
    buildHash: "one",
    purpose: "Support",
    idempotencyKey: "test-1",
  });
  expect(result.outcome).toMatchObject({ kind: "ok", value: { total: 24 } });
  expect(requests.at(-1)?.headers.get("authorization")).toBe(
    "Bearer private-runtime-token",
  );
  expect(requests.at(-1)?.headers.get("x-forge-purpose")).toBe("Support");
  expect(JSON.stringify(catalog)).not.toContain("private-runtime-token");
  build = "two";
  await expect(
    runtime.invoke({ operationId: "Quote", input: {}, buildHash: "one" }),
  ).rejects.toThrow(/changed/);
  expect(requests.filter((r) => r.url.endsWith("/quote"))).toHaveLength(1);
});
it("refuses redirects and paths that escape a configured runtime", async () => {
  const runtime = new RuntimeConnection(
    {
      id: "demo",
      name: "Demo",
      endpoint: "https://demo.example",
      token: "secret",
    },
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example" },
      }),
  );
  await expect(runtime.catalog()).rejects.toThrow(/redirect|302/i);
});
it("rejects mixed rollout metadata and encoded path traversal", async () => {
  const mixed = new RuntimeConnection(
    {
      id: "demo",
      name: "Demo",
      endpoint: "https://demo.example/runtime/demo",
      token: "private",
    },
    async (input) =>
      String(input).endsWith("/discovery")
        ? Response.json(
            { buildHash: "one" },
            { headers: { "x-forge-deployment": "a" } },
          )
        : Response.json(spec, { headers: { "x-forge-deployment": "b" } }),
  );
  await expect(mixed.catalog()).rejects.toThrow(/changed|mismatch/i);
  const paths = { ...spec, paths: { "/%2e%2e/admin": spec.paths["/quote"] } };
  const requests: string[] = [];
  const escaped = new RuntimeConnection(
    {
      id: "demo",
      name: "Demo",
      endpoint: "https://demo.example/runtime/demo",
      token: "private",
    },
    async (input) => {
      requests.push(String(input));
      return String(input).endsWith("/discovery")
        ? Response.json({
            buildHash: "one",
            features: ["invocation-preconditions"],
          })
        : Response.json(paths);
    },
  );
  await expect(
    escaped.invoke({ operationId: "Quote", input: {}, buildHash: "one" }),
  ).rejects.toThrow(/path/i);
  expect(requests.some((p) => p.includes("/admin"))).toBe(false);
});
