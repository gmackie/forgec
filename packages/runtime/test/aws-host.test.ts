import { describe, expect, it } from "vitest";
import { toRequest, toResult } from "../src/hosts/aws.js";

describe("API Gateway v2 <-> Fetch mapping", () => {
  it("maps method, path, query, headers and body", async () => {
    const req = toRequest({
      rawPath: "/v1/customers/queries/by-tier",
      rawQueryString: "tier=gold&limit=2",
      headers: { "x-forge-tenant": "acme", "content-type": "application/json" },
      requestContext: { http: { method: "POST" }, requestId: "r1", domainName: "api.example" },
      body: Buffer.from('{"a":1}').toString("base64"),
      isBase64Encoded: true,
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.example/v1/customers/queries/by-tier?tier=gold&limit=2");
    expect(req.headers.get("x-forge-tenant")).toBe("acme");
    expect(await req.text()).toBe('{"a":1}');
  });

  it("maps a Response back to a v2 result", async () => {
    const out = await toResult(new Response('{"ok":true}', { status: 201, headers: { etag: '"1"', "content-type": "application/json" } }));
    expect(out).toEqual({ statusCode: 201, headers: { etag: '"1"', "content-type": "application/json" }, body: '{"ok":true}' });
  });
});
