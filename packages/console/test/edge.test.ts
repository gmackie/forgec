import { expect, it, vi, afterEach } from "vitest";
import edge from "../src/edge.js";
afterEach(() => vi.unstubAllGlobals());
it("forwards only to the configured HTTPS origin and replaces the origin credential", async () => {
  const upstream = vi.fn(async (request: Request) => {
    expect(request.url).toBe("https://origin.example/__console/api/apps?x=1");
    expect(request.headers.get("x-forge-origin-token")).toBe("private-origin-token");
    expect(request.headers.get("authorization")).toBe("Bearer admin");
    expect(request.headers.get("origin")).toBe("https://forge.example");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({ name: "App" });
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", upstream);
  const result = await edge.fetch(new Request("https://forge.example/api/apps?x=1", {
    method: "POST", headers: { "authorization": "Bearer admin", "origin": "https://forge.example", "x-forge-origin-token": "untrusted" }, body: JSON.stringify({ name: "App" }),
  }), { ORIGIN_URL: "https://origin.example/__console", ORIGIN_TOKEN: "private-origin-token" });
  expect(result.status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});
it("fails closed for an unconfigured or insecure origin", async () => {
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  expect((await edge.fetch(new Request("https://forge.example/"), { ORIGIN_URL: "http://origin.example", ORIGIN_TOKEN: "" })).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});
