import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { compilePath, createHttpHandler, devHeaderAuth } from "../src/http.js";
import { defineFunction } from "../src/functions.js";
import {err} from "../src/errors.js";
import type {ApiPublicationProfile} from "../src/api-publication.js";

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
    expect(pre.headers.get("access-control-expose-headers")).toContain("www-authenticate");
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

it("rejects a stale build before executing a mutation", async () => {
 const stale = await handler(req("POST", "/v1/customers", {code:"guarded",name:"Guarded"}, {"x-forge-if-build":"stale"}));
 expect(stale.status).toBe(409);
 const accepted = await handler(req("POST", "/v1/customers", {code:"guarded",name:"Guarded"}, {"x-forge-if-build":bundle.buildHash}));
 expect(accepted.status).toBe(201);
 const discovery = await handler(req("GET", "/forge/discovery"));
 expect(discovery.headers.get("x-forge-build")).toBe(bundle.buildHash);
 expect((await discovery.json()).features).toContain("invocation-preconditions");
});

it("authenticates workspace discovery and exposes only record and changeset/import routes", async () => {
  const anonymous = await handler(new Request("https://api.test/forge/workspace.json"));
  expect(anonymous.status).toBe(401);
  const response = await handler(req("GET", "/forge/workspace.json"));
  expect(response.headers.get("x-forge-build")).toBe(bundle.buildHash);
  const workspace = await response.json();
  expect(workspace.descriptor).toEqual(bundle.ui);
  expect(workspace.operations.some((o: any) => o.kind === "changeset.propose")).toBe(true);
  expect(workspace.operations.some((o: any) => o.kind.startsWith("admin.") || o.kind === "function")).toBe(false);
  expect((await handler(req("GET", "/forge/workspace.json", undefined, {"x-forge-if-build":"old"}))).status).toBe(409);
});

describe("mixed literal + parameter path segments (FORG-4)", () => {
  // A path such as "/git/{owner}/{repo}.git/info/refs" carries a parameter and a literal in one segment.
  // The compiler, OpenAPI projection and generated client all treat `{repo}` as the parameter; the router must too.
  const withPath = (path: string) => {
    const b = structuredClone(bundle);
    for (const m of b.ir.modules) for (const f of m.functions ?? []) if (f.name === "SubmitOrder") f.http = { method: "POST", path };
    const mm = new Model(b);
    // Submits the order named by the bound `order` parameter, so a misparsed parameter cannot pass.
    const submit = defineFunction("@acme/commerce/_/SubmitOrder", (deps) => {
      const input = deps.input as { order: string; expectedVersion: number };
      return deps.transitions.Order!.submit!(input.order, input.expectedVersion, {});
    });
    return createHttpHandler(mm, new Engine(mm, testLayer(new MemoryStorage()), { functions: [submit] }), { auth: devHeaderAuth() });
  };
  const seed = async (h: (r: Request) => Promise<Response>) => {
    const cust = await (await h(req("POST", "/v1/customers", { code: "acme", name: "Acme" }))).json();
    const site = await (await h(req("POST", "/v1/sites", { customer: cust.id, code: "hq", name: "HQ", timezone: "UTC" }))).json();
    return (await (await h(req("POST", "/v1/orders", { customer: cust.id, site: site.id, subtotal: "10.00", tax: "0.50", requestedOn: "2026-09-20" }))).json()) as { id: string };
  };

  it("binds the parameter from a suffixed segment and requires the literal suffix", async () => {
    const h = withPath("/v1/orders/{order}.json/submit");
    const order = await seed(h);
    const ok = await h(req("POST", `/v1/orders/${order.id}.json/submit`, {}, { "if-match": '"1"' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("Submitted");
    expect((await h(req("POST", `/v1/orders/${order.id}/submit`, {}, { "if-match": '"2"' }))).status).toBe(404);
    expect((await h(req("POST", `/v1/orders/${order.id}.xml/submit`, {}, { "if-match": '"2"' }))).status).toBe(404);
  });

  it("binds prefixed and infix parameters and rejects an empty value", async () => {
    const pre = withPath("/v1/orders/order-{order}/submit");
    const a = await seed(pre);
    expect((await pre(req("POST", `/v1/orders/order-${a.id}/submit`, {}, { "if-match": '"1"' }))).status).toBe(200);
    expect((await pre(req("POST", "/v1/orders/order-/submit", {}, { "if-match": '"1"' }))).status).toBe(404);
    const infix = withPath("/v1/orders/x{order}.y/submit");
    const b = await seed(infix);
    const res = await infix(req("POST", `/v1/orders/x${encodeURIComponent(b.id)}.y/submit`, {}, { "if-match": '"1"' }));
    expect(res.status).toBe(200);
  });
});

describe("compilePath (FORG-4)", () => {
  it("compiles the git smart-HTTP template into literal, parameter and mixed segments", () => {
    const segs = compilePath("/git/{owner}/{repo}.git/info/refs");
    expect(segs.map((s) => s.literal ?? s.param ?? s.pattern!.params)).toEqual(["git", "owner", ["repo"], "info", "refs"]);
    const re = segs[2]!.pattern!.regex;
    expect(re.exec("forgec.git")?.[1]).toBe("forgec");
    expect(re.exec("my.repo.git")?.[1]).toBe("my.repo");
    expect(re.exec("forgecXgit")).toBeNull();
    expect(re.exec(".git")).toBeNull();
  });

  it("rejects malformed templates instead of routing a mangled parameter name", () => {
    expect(() => compilePath("/git/{repo.git")).toThrow(/malformed path template/);
    expect(() => compilePath("/git/repo}.git")).toThrow(/malformed path template/);
    expect(() => compilePath("/git/{}")).toThrow(/malformed path template/);
  });
});


describe("standards-first discovery remains opt-in and read-only", () => {
  const publication: ApiPublicationProfile = {
    version: "forge-api-publication/1",
    resource: "https://api.test",
    authorizationServers: ["https://auth.example.test"],
    scopesSupported: ["orders:read"],
    services: [{endpoint: "https://api.test/v1/orders", serviceDesc: "https://api.test/forge/openapi.json", visibility: "public"}],
  };
  it("publishes GET and HEAD before authentication without exposing private contract routes", async () => {
    const protectedHandler = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), {
      auth: {scheme: "oauth2", authenticate: async () => err("Unauthenticated", "access token required")},
      publication,
    });
    const catalog = await protectedHandler(new Request("https://api.test/.well-known/api-catalog"));
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get("content-type")).toContain("application/linkset+json");
    expect((await catalog.json()).linkset).toHaveLength(2);
    const head = await protectedHandler(new Request("https://api.test/.well-known/api-catalog", {method:"HEAD"}));
    expect(head.status).toBe(200);
    expect(head.headers.get("link")).toContain("api-catalog");
    const resource = await protectedHandler(new Request("https://api.test/.well-known/oauth-protected-resource"));
    expect((await resource.json()).resource).toBe("https://api.test");
    const privateSpec = await protectedHandler(new Request("https://api.test/forge/openapi.json"));
    expect(privateSpec.status).toBe(401);
    expect(privateSpec.headers.get("www-authenticate")).toContain("resource_metadata");
    const exactResource = await protectedHandler(new Request("https://api.test/"));
    expect(exactResource.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://api.test/.well-known/oauth-protected-resource"');
    const denied = await protectedHandler(new Request("https://api.test/v1/orders"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("resource_metadata");
    const invalidBearer = await protectedHandler(new Request("https://api.test/v1/orders",{
      headers:{authorization:"Bearer invalid-token"},
    }));
    expect(invalidBearer.status).toBe(401);
    expect(invalidBearer.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(invalidBearer.headers.get("www-authenticate")).toContain("resource_metadata");
  });
  it("provides a Bearer RFC 6750 challenge without inventing resource metadata",async()=>{
    const standalone=createHttpHandler(model,new Engine(model,testLayer(new MemoryStorage())),{
      auth:{scheme:"oauth2",authenticate:async()=>err("Unauthenticated","invalid_token")},
    });
    const missing=await standalone(new Request("https://api.test/v1/orders"));
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    const invalid=await standalone(new Request("https://api.test/v1/orders",{
      headers:{authorization:"Bearer malformed"}
    }));
    expect(invalid.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });
  it("does not publish any new well-known route unless an operator opted in", async () => {
    expect((await handler(req("GET", "/.well-known/api-catalog"))).status).toBe(404);
  });
});
