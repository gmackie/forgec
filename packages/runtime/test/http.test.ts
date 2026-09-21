import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createHttpHandler, devHeaderAuth } from "../src/http.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);

let handler: (req: Request) => Promise<Response>;
const H = { "content-type": "application/json", "x-forge-tenant": "acme", "x-forge-actor": "operator" };
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://api.test${path}`, { method, headers: { ...H, ...headers }, body: body === undefined ? null : JSON.stringify(body) });

beforeEach(() => {
  handler = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), { auth: devHeaderAuth() });
});

describe("HTTP binding", () => {
  it("POST creates and returns 201 with a strong ETag", async () => {
    const res = await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toMatchObject({ id: "cus_0001", version: 1, code: "ACME" });
  });

  it("GET by id returns 200 + ETag, 404 problem details when missing, and never leaks other tenants", async () => {
    const c = await (await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }))).json();
    const ok = await handler(req("GET", `/v1/customers/${c.id}`));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"1"');
    const missing = await handler(req("GET", "/v1/customers/nope"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("application/problem+json");
    expect(await missing.json()).toMatchObject({ code: "NotFound", status: 404, retryable: false, type: "https://forge.dev/errors/not-found" });
    const other = await handler(req("GET", `/v1/customers/${c.id}`, undefined, { "x-forge-tenant": "other" }));
    expect(other.status).toBe(404);
  });

  it("PATCH requires If-Match (428), rejects a stale If-Match (412), and succeeds with the current one", async () => {
    const c = await (await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }))).json();
    expect((await handler(req("PATCH", `/v1/customers/${c.id}`, { name: "B" }))).status).toBe(428);
    const stale = await handler(req("PATCH", `/v1/customers/${c.id}`, { name: "B" }, { "if-match": '"9"' }));
    expect(stale.status).toBe(412);
    expect((await stale.json()).code).toBe("VersionConflict");
    const ok = await handler(req("PATCH", `/v1/customers/${c.id}`, { name: "B" }, { "if-match": '"1"' }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"2"');
  });

  it("maps validation, unknown fields, malformed JSON and unauthenticated requests to the spec'd statuses", async () => {
    expect((await handler(req("POST", "/v1/customers", { code: "ab", name: "" }))).status).toBe(422);
    expect((await handler(req("POST", "/v1/customers", { code: "acme", name: "A", version: 4 }))).status).toBe(422);
    const malformed = await handler(new Request("https://api.test/v1/customers", { method: "POST", headers: H, body: "{nope" }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe("MalformedRequest");
    const anon = await handler(new Request("https://api.test/v1/customers", { method: "GET" }));
    expect(anon.status).toBe(401);
  });

  it("DELETE soft-deletes, restore reinstates, both under If-Match", async () => {
    const c = await (await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }))).json();
    const del = await handler(req("DELETE", `/v1/customers/${c.id}`, undefined, { "if-match": '"1"' }));
    expect(del.status).toBe(200);
    expect((await del.json()).deletedAt).not.toBeNull();
    expect((await handler(req("GET", `/v1/customers/${c.id}`))).status).toBe(404);
    const restored = await handler(req("POST", `/v1/customers/${c.id}/restore`, undefined, { "if-match": '"2"' }));
    expect(restored.status).toBe(200);
    expect((await restored.json()).deletedAt).toBeNull();
  });

  it("named queries: find returns one record or 404; list pages with cursor and limit from the query string", async () => {
    for (const [code, name] of [["AAA", "Zed"], ["BBB", "Amy"], ["CCC", "Bob"]]) {
      await handler(req("POST", "/v1/customers", { code, name, tier: "gold" }));
    }
    const found = await handler(req("GET", "/v1/customers/queries/by-code?code=bbb"));
    expect(found.status).toBe(200);
    expect((await found.json()).name).toBe("Amy");
    expect((await handler(req("GET", "/v1/customers/queries/by-code?code=zzz"))).status).toBe(404);
    const p1 = await (await handler(req("GET", "/v1/customers/queries/by-tier?tier=gold&limit=2"))).json();
    expect(p1.items.map((i: any) => i.name)).toEqual(["Amy", "Bob"]);
    const p2 = await (await handler(req("GET", `/v1/customers/queries/by-tier?tier=gold&limit=2&cursor=${encodeURIComponent(p1.next)}`))).json();
    expect(p2.items.map((i: any) => i.name)).toEqual(["Zed"]);
    expect(p2.next).toBeNull();
  });

  it("Idempotency-Key replays the same response and rejects a different body with 409", async () => {
    const a = await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }, { "idempotency-key": "k1" }));
    const b = await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }, { "idempotency-key": "k1" }));
    expect(b.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    const c = await handler(req("POST", "/v1/customers", { code: "acme", name: "Other" }, { "idempotency-key": "k1" }));
    expect(c.status).toBe(409);
    expect((await c.json()).code).toBe("IdempotencyMismatch");
  });

  it("exposed lifecycle actions are routed; unexposed ones are 404; unknown routes 404; wrong method 405", async () => {
    const cust = await (await handler(req("POST", "/v1/customers", { code: "acme", name: "Acme" }))).json();
    const site = await (await handler(req("POST", "/v1/sites", { customer: cust.id, code: "hq", name: "HQ", timezone: "UTC" }))).json();
    const order = await (await handler(req("POST", "/v1/orders", { customer: cust.id, site: site.id, subtotal: "10.00", tax: "0.50", requestedOn: "2026-09-20" }))).json();
    const cancelled = await handler(req("POST", `/v1/orders/${order.id}/actions/cancel`, { reason: "no" }, { "if-match": '"1"' }));
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).status).toBe("Cancelled");
    expect((await handler(req("POST", `/v1/orders/${order.id}/actions/submit`, {}, { "if-match": '"2"' }))).status).toBe(404);
    expect((await handler(req("GET", "/v1/nothing"))).status).toBe(404);
    expect((await handler(req("PUT", `/v1/customers/${cust.id}`, {}))).status).toBe(405);
  });
});

describe("CORS", () => {
  it("answers preflight and echoes an allowed origin on responses when configured", async () => {
    const h = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), { auth: devHeaderAuth(), cors: { origins: ["http://localhost:5173"] } });
    const pre = await h(new Request("https://api.test/v1/customers", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type,if-match,x-forge-tenant" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(pre.headers.get("access-control-allow-headers")).toContain("if-match");
    expect(pre.headers.get("access-control-expose-headers")).toContain("etag");
    const res = await h(req("POST", "/v1/customers", { code: "acme", name: "A" }, { origin: "http://localhost:5173" }));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await h(req("GET", "/v1/customers/x", undefined, { origin: "https://evil.example" }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});

/** FORGE-056: bounded, authenticated discovery. Metadata for compatibility evaluation, never deployment trust. */
describe("discovery", () => {
  it("GET /forge/discovery is authenticated, bounded, and names contract digests, features and auth", async () => {
    const anon = await handler(new Request("https://api.test/forge/discovery"));
    expect(anon.status).toBe(401);
    const res = await handler(req("GET", "/forge/discovery"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    const d = await res.json();
    expect(d.version).toBe("forge-discovery/1");
    expect(d.package).toMatchObject({ name: "@acme/commerce", version: bundle.ir.package.version });
    expect(d.buildHash).toBe(bundle.buildHash);
    expect(d.digests).toEqual(bundle.digests);
    expect(d.contracts.version).toBe(bundle.contracts.version);
    expect(d.auth).toEqual({ scheme: "dev-header", purposeHeader: "x-forge-purpose" });
    expect(d.features).toEqual(expect.arrayContaining(["changesets", "imports", "workflows", "realtime"]));
    expect(d.links).toEqual({ openapi: "/forge/openapi.json", mcp: "/forge/mcp" });
    // bounded: counts and edition, not an operation-by-operation catalogue (the OpenAPI document carries that)
    expect(d.operations).toEqual({ resources: bundle.contracts.resources.length, functions: expect.any(Number), workflows: 1, http: expect.any(Number) });
    expect(Object.keys(d).sort()).toEqual(["auth", "buildHash", "contracts", "digests", "edition", "features", "links", "operations", "package", "profile", "version"]);
  });

  it("GET /forge/openapi.json serves the projection the build emitted, only to authenticated callers", async () => {
    expect((await handler(new Request("https://api.test/forge/openapi.json"))).status).toBe(401);
    const res = await handler(req("GET", "/forge/openapi.json"));
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info["x-forge-contracts"]).toBe(bundle.contracts.version);
    expect(Object.keys(doc.paths)).toContain("/v1/customers/{id}");
    expect(doc.paths["/v1/customers/{id}"].patch.operationId).toBe("@acme/commerce/_/Customer.update");
  });
});

/** The Node host must never trust caller-supplied identity headers unless that was asked for explicitly. */
describe("host authentication is fail-closed", () => {
  it("createNodeHost refuses to start without an auth host, and only dev-headers opt-in changes that", async () => {
    const { createNodeHost } = await import("../src/hosts/node.js");
    const { MemoryStorage } = await import("../src/adapters/memory.js");
    const base = { bundle, store: new MemoryStorage(), cursorSecret: "t", sweepIntervalMs: 0, telemetryFormat: "silent" as const };
    const saved = process.env["FORGE_AUTH"];
    delete process.env["FORGE_AUTH"];
    expect(() => createNodeHost(base)).toThrow(/no authentication host configured/);
    // the opt-in is explicit and named; nothing about the request path can enable it
    process.env["FORGE_AUTH"] = "dev-headers";
    const dev = createNodeHost(base);
    expect(dev).toBeTruthy();
    await dev.stop().catch(() => undefined);
    process.env["FORGE_AUTH"] = "something-else";
    expect(() => createNodeHost(base)).toThrow(/no authentication host configured/);
    if (saved === undefined) delete process.env["FORGE_AUTH"]; else process.env["FORGE_AUTH"] = saved;
    // passing an auth host directly never consults the environment
    const explicit = createNodeHost({ ...base, auth: devHeaderAuth() });
    expect(explicit).toBeTruthy();
    await explicit.stop().catch(() => undefined);
  });
});
