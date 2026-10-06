import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { contractIrSchema, contractToOpenApi } from "../src/contract-openapi.js";
import {
  ForgeGraphRegistry,
  Integrations,
  integrationOverrides,
  publicBaseUrl,
  type IntegrationOverride,
} from "../src/integrations.js";
import { missingConfiguration } from "../src/config.js";
import { createApi } from "../src/api.js";
import { SqliteState } from "../src/sqlite.js";

// Synthetic: the shapes of contract IR v1, not a real app's contract (fingerprints are placeholders).
const contract = contractIrSchema.parse(
  JSON.parse(readFileSync(new URL("./fixtures/contract-ir.json", import.meta.url), "utf8")),
);
const apps = [
  { slug: "notes", name: "Notes", description: "Note service", healthCheckUrl: "https://notes.example.com/.well-known/forge-health" },
  { slug: "quiet", name: "Quiet", healthCheckUrl: null },
  { slug: "secret-app", name: "Secret" },
];

describe("contract IR → OpenAPI", () => {
  it("keeps paths, parameters, bodies, responses, security and shared components", () => {
    const doc = contractToOpenApi(contract, { title: "Notes", serverUrl: "https://notes.example.com" }) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://notes.example.com" }]);
    const get = doc.paths["/notes/{id}"].get;
    expect(get.operationId).toBe("notes.notes.get");
    expect(get.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "view", in: "query", required: true, schema: { type: "string", enum: ["full", "summary"] } },
      { name: "lang", in: "query", required: false, schema: { type: "string" } },
      { name: "X-Trace", in: "header", required: false, schema: { type: "string" } },
    ]);
    expect(get.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Note" });
    expect(get.responses["404"]).toEqual({ description: "Error" });
    expect(get.security).toEqual([{ bearer: [] }]);
    expect(get["x-forge-public"]).toBe(true);
    expect(doc.paths["/notes"].post.requestBody.content["application/json"].schema.required).toEqual(["title"]);
    expect(doc.paths["/notes/{id}"].delete.responses["204"]).toEqual({ description: "Success" });
    // `$ref`s resolve: components land under components.schemas.
    expect(doc.components.schemas.Note.required).toEqual(["id", "title"]);
    expect(doc.components.securitySchemes.bearer).toEqual({ type: "http", scheme: "bearer" });
  });
  it("reports operations it cannot express instead of approximating them", () => {
    const doc = contractToOpenApi(contract, { title: "Notes" }) as any;
    expect(doc["x-forge-skipped"]).toEqual([{ operationId: "notes.sync.pull", reason: "rpc transport" }]);
    expect(doc.servers).toBeUndefined();
  });
});

describe("integration settings", () => {
  it("accepts only public https base URLs", () => {
    expect(publicBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    // The local acceptance switch allows loopback http, still without credentials or queries.
    expect(publicBaseUrl("http://127.0.0.1:8789/api/", true)).toBe("http://127.0.0.1:8789/api");
    expect(() => publicBaseUrl("http://u:p@127.0.0.1:8789", true)).toThrow();
    expect(() => publicBaseUrl("ftp://127.0.0.1", true)).toThrow();
    for (const bad of [
      "http://api.example.com",
      "https://127.0.0.1",
      "https://10.0.0.1/api",
      "https://[::1]",
      "https://localhost",
      "https://metadata.google.internal",
      "https://printer.local",
      "https://api.example.com:8443",
      "https://user:pass@api.example.com",
      "https://api.example.com/?a=1",
      "https://intranet",
    ])
      expect(() => publicBaseUrl(bad), bad).toThrow();
  });
  it("only lets integrations name INTEGRATION_* secrets, so instance secrets cannot be sent elsewhere", () => {
    expect(() =>
      integrationOverrides(JSON.stringify([{ app: "notes", auth: { kind: "bearer", secret: "ADMIN_TOKEN" } }])),
    ).toThrow();
    expect(() => integrationOverrides(JSON.stringify([{ app: "notes" }, { app: "notes" }]))).toThrow("Duplicate");
    expect(() => integrationOverrides(JSON.stringify([{ app: "notes", baseUrl: "http://notes.example.com" }]))).toThrow();
    expect(() => integrationOverrides(JSON.stringify([{ app: "notes", extra: 1 }]))).toThrow();
    expect(integrationOverrides(undefined)).toEqual([]);
  });
  it("reports missing ForgeGraph token and named credentials by name only", () => {
    const base = { INSTANCE_AUTHORITY: "x", ADMIN_TOKEN: "t".repeat(32) };
    expect(missingConfiguration({ ...base, FORGEGRAPH_URL: "https://fg.example.com" })).toEqual(["FORGEGRAPH_TOKEN"]);
    const integrations = JSON.stringify([
      { app: "notes", auth: { kind: "bearer", secret: "INTEGRATION_NOTES" } },
      { app: "quiet", auth: { kind: "cloudflare-access", clientId: "INTEGRATION_QUIET_ID", clientSecret: "INTEGRATION_QUIET_SECRET" } },
    ]);
    expect(
      missingConfiguration({ ...base, FORGEGRAPH_URL: "https://fg.example.com", FORGEGRAPH_TOKEN: "fg", INTEGRATIONS_JSON: integrations, INTEGRATION_QUIET_ID: "id" }),
    ).toEqual(["INTEGRATION_NOTES", "INTEGRATION_QUIET_SECRET"]);
  });
});

type Seen = { url: string; method: string; headers: Headers; body: string | undefined };
function setup(
  overrides: IntegrationOverride[] = [],
  upstream: (req: Seen) => Response = () => Response.json({ id: "n1", title: "Hello" }),
  secrets: Record<string, string> = {},
) {
  const registryCalls: string[] = [];
  const registryFetch = (async (input: string | URL) => {
    const url = String(input);
    registryCalls.push(url);
    if (url.endsWith("/api/fg/apps")) return Response.json({ apps });
    if (url.includes("appSlug=notes")) return Response.json({ ir: contract });
    return Response.json({ error: "no contract published" }, { status: 404 });
  }) as typeof fetch;
  const seen: Seen[] = [];
  const upstreamFetch = (async (input: string | URL, init?: RequestInit) => {
    const req = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body as string | undefined };
    seen.push(req);
    return upstream(req);
  }) as typeof fetch;
  let clock = 1_000;
  const integrations = new Integrations(
    new ForgeGraphRegistry("https://fg.example.com", "fg-read-token", registryFetch),
    overrides,
    secrets,
    upstreamFetch,
    () => (clock += 5),
  );
  return { integrations, seen, registryCalls };
}

describe("integration catalog", () => {
  it("lists ForgeGraph apps, defaults the base URL to the health-check origin and applies overrides", async () => {
    const { integrations } = setup([
      { app: "quiet", baseUrl: "https://quiet.example.com/api", writes: true, name: "Quiet API" },
      { app: "secret-app", hidden: true },
    ]);
    expect(await integrations.list()).toEqual([
      { id: "notes", name: "Notes", app: "notes", description: "Note service", baseUrl: "https://notes.example.com", auth: "none", writes: false },
      { id: "quiet", name: "Quiet API", app: "quiet", description: null, baseUrl: "https://quiet.example.com/api", auth: "none", writes: true },
    ]);
    await expect(integrations.describe("secret-app")).rejects.toMatchObject({ status: 404 });
  });
  it("describes operations from the contract and caches it", async () => {
    const { integrations, registryCalls } = setup();
    const described = await integrations.describe("notes");
    expect(described.operations.map((o) => `${o.method} ${o.path}`)).toEqual(["post /notes", "get /notes/{id}", "delete /notes/{id}"]);
    await integrations.describe("notes");
    expect(registryCalls.filter((u) => u.includes("contracts"))).toHaveLength(1);
    await expect(integrations.describe("quiet")).rejects.toMatchObject({ status: 404, message: expect.stringContaining("fg contract publish") });
  });
  it("gives each operation a starting request from its schemas, resolving $refs", async () => {
    const { integrations } = setup();
    const ops = (await integrations.describe("notes")).operations;
    expect(ops.find((o) => o.operationId === "notes.notes.get")!.sample).toEqual({ path: { id: "sample" }, query: { view: "full" }, headers: {} });
    expect(ops.find((o) => o.operationId === "notes.notes.create")!.sample.body).toEqual({ title: "sample" });
  });
  it("converts only the requested operations for the graph importer", async () => {
    const { integrations } = setup();
    const doc = (await integrations.openapi("notes", ["notes.notes.get"])) as any;
    expect(Object.keys(doc.paths)).toEqual(["/notes/{id}"]);
    expect(Object.keys(doc.paths["/notes/{id}"])).toEqual(["get"]);
    await expect(integrations.openapi("notes", ["notes.notes.nope"])).rejects.toMatchObject({ status: 404 });
  });
  it("names a refused ForgeGraph token without revealing it", async () => {
    const registry = new ForgeGraphRegistry("https://fg.example.com", "fg-read-token", (async () => new Response("no", { status: 403 })) as typeof fetch);
    const error = await registry.apps().catch((e) => e);
    expect(error.message).toContain("FORGEGRAPH_TOKEN");
    expect(error.message).not.toContain("fg-read-token");
  });
});

describe("integration proxy", () => {
  it("expands path parameters safely, sends declared query and headers, and injects the credential last", async () => {
    const { integrations, seen } = setup([{ app: "notes", auth: { kind: "bearer", secret: "INTEGRATION_NOTES" } }], undefined, { INTEGRATION_NOTES: "notes-secret" });
    const result = await integrations.call("notes", {
      operationId: "notes.notes.get",
      path: { id: "a/../b c" },
      query: { view: "full" },
      headers: { "x-trace": "abc" },
    });
    expect(seen[0]!.url).toBe("https://notes.example.com/notes/a%2F..%2Fb%20c?view=full");
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer notes-secret");
    expect(seen[0]!.headers.get("x-trace")).toBe("abc");
    expect(result).toMatchObject({ status: 200, ok: true, bodyKind: "json", body: { id: "n1", title: "Hello" } });
    expect(JSON.stringify(result)).not.toContain("notes-secret");
  });
  it("keeps a base path prefix", async () => {
    const { integrations, seen } = setup([{ app: "notes", baseUrl: "https://api.example.com/api/fg" }]);
    await integrations.call("notes", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" } });
    expect(seen[0]!.url).toBe("https://api.example.com/api/fg/notes/1?view=full");
  });
  it("refuses undeclared, reserved and missing parameters before calling", async () => {
    const { integrations, seen } = setup();
    const call = (input: object) => integrations.call("notes", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" }, ...input });
    await expect(call({ query: { view: "full", debug: "1" } })).rejects.toMatchObject({ status: 400 });
    await expect(call({ headers: { authorization: "Bearer mine" } })).rejects.toMatchObject({ status: 400 });
    await expect(call({ headers: { cookie: "a=b" } })).rejects.toMatchObject({ status: 400 });
    await expect(call({ path: { id: ".." } })).rejects.toMatchObject({ status: 400 });
    await expect(call({ path: {} })).rejects.toMatchObject({ status: 400 });
    await expect(call({ query: {} })).rejects.toMatchObject({ status: 400 });
    await expect(call({ operationId: "notes.sync.pull" })).rejects.toMatchObject({ status: 404 });
    await expect(call({ body: { a: 1 } })).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(0);
  });
  it("reads by default; writes need the integration's opt-in and a per-call confirmation", async () => {
    const write = { operationId: "notes.notes.create", body: { title: "New" } };
    const locked = setup();
    await expect(locked.integrations.call("notes", { ...write, confirmWrite: true })).rejects.toMatchObject({ status: 403 });
    const open = setup([{ app: "notes", writes: true }], () => Response.json({ id: "n2", title: "New" }, { status: 201 }));
    await expect(open.integrations.call("notes", write)).rejects.toMatchObject({ status: 428 });
    expect(open.seen).toHaveLength(0);
    const result = await open.integrations.call("notes", { ...write, confirmWrite: true });
    expect(open.seen[0]).toMatchObject({ method: "POST", body: JSON.stringify({ title: "New" }) });
    expect(open.seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(result.status).toBe(201);
  });
  it("refuses redirects, caps responses and filters response headers", async () => {
    const redirect = setup([], () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com" } }));
    await expect(redirect.integrations.call("notes", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" } })).rejects.toMatchObject({ status: 502 });
    const huge = setup([], () => new Response("x".repeat(2_000_001), { headers: { "content-type": "text/plain" } }));
    await expect(huge.integrations.call("notes", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" } })).rejects.toMatchObject({ status: 502 });
    const headers = setup([], () => Response.json({}, { headers: { "set-cookie": "s=1", "x-request-id": "r1", server: "nginx" } }));
    const result = await headers.integrations.call("notes", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" } });
    expect(result.headers).toEqual({ "content-type": "application/json", "x-request-id": "r1" });
  });
  it("names a missing credential without calling the integration", async () => {
    const { integrations, seen } = setup([{ app: "notes", auth: { kind: "cloudflare-access", clientId: "INTEGRATION_ID", clientSecret: "INTEGRATION_SECRET" } }]);
    await expect(integrations.call("notes", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" } })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("INTEGRATION_ID"),
    });
    expect(seen).toHaveLength(0);
  });
  it("needs a base URL before it calls anything", async () => {
    const { integrations } = setup();
    await expect(integrations.call("quiet", { operationId: "x" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("integrations API", () => {
  const token = "a-test-administrator-token-that-is-long";
  function api(integrations: Integrations | null) {
    const store = new SqliteState(new DatabaseSync(":memory:"));
    const handler = createApi({ store, token, authority: "standalone.example", name: "Forge", runtime: "node", registry: null, integrations });
    const call = (path: string, method = "GET", body?: unknown) =>
      handler(
        new Request(`http://localhost/api${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    return { call, store };
  }
  it("reports when integrations are not configured", async () => {
    const { call } = api(null);
    expect(await (await call("/integrations")).json()).toEqual({ configured: false, integrations: [] });
    expect((await call("/integrations/notes")).status).toBe(404);
  });
  it("lists, describes, converts and calls, auditing writes only", async () => {
    const { integrations } = setup([{ app: "notes", writes: true }], () => Response.json({ id: "n1", title: "Hello" }, { status: 201 }));
    const { call, store } = api(integrations);
    expect((await (await call("/integrations")).json()).integrations.map((i: any) => i.id)).toEqual(["notes", "quiet", "secret-app"]);
    expect((await (await call("/integrations/notes")).json()).operations).toHaveLength(3);
    expect((await (await call("/integrations/notes/openapi")).json()).openapi).toBe("3.1.0");
    const read = await call("/integrations/notes/call", "POST", { operationId: "notes.notes.get", path: { id: "1" }, query: { view: "full" } });
    expect(read.status).toBe(200);
    expect((await store.read()).audit).toHaveLength(0);
    const write = await call("/integrations/notes/call", "POST", { operationId: "notes.notes.create", body: { title: "x" }, confirmWrite: true });
    expect((await write.json()).status).toBe(201);
    expect((await store.read()).audit[0]).toMatchObject({ action: "Integration write", subject: "notes notes.notes.create → 201" });
    expect((await call("/integrations/notes/call", "POST", { operationId: "notes.notes.get", stray: 1 })).status).toBe(400);
  });
});
