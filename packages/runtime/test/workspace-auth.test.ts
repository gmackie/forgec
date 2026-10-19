import { describe, expect, it, vi } from "vitest";
import { workspaceAuth, type WorkspaceAuthOptions, type VerifiedApiToken } from "../src/workspace-auth.js";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createHttpHandler } from "../src/http.js";
import { createNodeHost } from "../src/hosts/node.js";
import { createWorker, type WorkerEnv } from "../src/hosts/cloudflare.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const now = 1_000_000;
const token: VerifiedApiToken = { actor: "user", workspaceId: "workspace", expiresAt: now + 1000, revoked: false, purposes: ["read", "admin"] };
function setup(overrides: Partial<WorkspaceAuthOptions> = {}) {
  const options: WorkspaceAuthOptions = {
    workspaceId: "workspace", issuer: "application", now: () => now,
    membership: vi.fn(async () => ({ actor: "user", workspaceId: "workspace", active: true, purposes: ["read", "write"] })),
    verifyApiToken: vi.fn(async () => token),
    getSession: vi.fn(async () => ({ user: { id: "user" }, session: { userId: "user", expiresAt: new Date(now + 1000) } })),
    sessionOrigins: ["https://app.test"], ...overrides,
  };
  return { options, auth: workspaceAuth(options) };
}
function request(headers: Record<string, string> = {}, method = "GET") { return new Request("https://app.test/v1/customers?workspaceId=evil", { method, headers }); }
describe("application workspace authentication", () => {
  it("requires a credential even when identity headers are supplied", async () => {
    const { auth, options } = setup();
    expect(await auth.authenticate(request({ "x-forge-tenant": "workspace", "x-forge-actor": "admin" }))).toMatchObject({ code: "Unauthenticated" });
    expect(options.membership).not.toHaveBeenCalled();
  });
  it("uses verified bearer identity and intersects purposes, ignoring caller workspace/actor/workload", async () => {
    const { auth, options } = setup({ workload: "deployment" });
    expect(await auth.authenticate(request({ authorization: "Bearer opaque", "x-forge-tenant": "evil", "x-forge-actor": "admin", "x-forge-workload": "evil" }))).toEqual({ tenant: "workspace", actor: "user", issuer: "application", purposes: ["read"], workload: "deployment" });
    expect(options.membership).toHaveBeenCalledWith("user", "workspace");
    expect(options.getSession).not.toHaveBeenCalled();
  });
  it.each([null, { ...token, revoked: true }, { ...token, expiresAt: now }, { ...token, expiresAt: "invalid" }, { ...token, expiresAt: Infinity }, { ...token, actor: "" }])("denies invalid/expired/revoked tokens without cookie fallback: %j", async credential => {
    const { auth, options } = setup({ verifyApiToken: async () => credential });
    expect(await auth.authenticate(request({ authorization: "Bearer opaque", cookie: "session=valid" }))).toMatchObject({ code: "Unauthenticated" });
    expect(options.getSession).not.toHaveBeenCalled();
  });
  it.each(["Basic abc", "Bearer", "Bearer one,two", "Bearer one two", "Bearer " + "x".repeat(8193)])("denies malformed or oversized bearer", async authorization => {
    const { auth, options } = setup();
    expect(await auth.authenticate(request({ authorization, cookie: "session=valid" }))).toMatchObject({ code: "Unauthenticated" });
    expect(options.verifyApiToken).not.toHaveBeenCalled();
    expect(options.getSession).not.toHaveBeenCalled();
  });
  it("denies a token from another workspace before membership lookup", async () => {
    const { auth, options } = setup({ verifyApiToken: async () => ({ ...token, workspaceId: "other" }) });
    expect(await auth.authenticate(request({ authorization: "Bearer opaque" }))).toMatchObject({ code: "Forbidden" });
    expect(options.membership).not.toHaveBeenCalled();
  });
  it("forwards only cookies and disables BetterAuth cookie caching", async () => {
    const { auth, options } = setup();
    expect(await auth.authenticate(request({ cookie: "session=valid", "x-forge-tenant": "evil" }))).toMatchObject({ tenant: "workspace", actor: "user", purposes: ["read", "write"] });
    const input = vi.mocked(options.getSession!).mock.calls[0]![0];
    const forwarded: string[] = [];
    input.headers.forEach((value, key) => forwarded.push(`${key}=${value}`));
    expect(forwarded).toEqual(["cookie=session=valid"]);
    expect(input.query).toEqual({ disableCookieCache: true });
  });
  it.each([null, { user: { id: "user" }, session: { userId: "user", expiresAt: now } }, { user: { id: "user" }, session: { userId: "other", expiresAt: now + 1000 } }])("denies missing/expired/inconsistent session", async session => {
    const { auth } = setup({ getSession: async () => session });
    expect(await auth.authenticate(request({ cookie: "session=valid" }))).toMatchObject({ code: "Unauthenticated" });
  });
  it("requires a trusted origin for cookie-authenticated writes", async () => {
    const { auth } = setup();
    for (const origin of [undefined, "https://evil.test", "null"]) expect(await auth.authenticate(request({ cookie: "session=valid", ...(origin ? { origin } : {}) }, "POST"))).toMatchObject({ code: "Forbidden" });
    expect(await auth.authenticate(request({ cookie: "session=valid", origin: "https://app.test" }, "POST"))).toMatchObject({ actor: "user" });
    expect(await auth.authenticate(request({ authorization: "Bearer opaque" }, "POST"))).toMatchObject({ actor: "user" });
  });
  it.each([null, { actor: "user", workspaceId: "workspace", active: false, purposes: [] }, { actor: "other", workspaceId: "workspace", active: true, purposes: [] }, { actor: "user", workspaceId: "other", active: true, purposes: [] }])("denies missing/revoked/foreign membership", async membership => {
    const { auth } = setup({ membership: async () => membership });
    expect(await auth.authenticate(request({ authorization: "Bearer opaque" }))).toMatchObject({ code: "Forbidden" });
  });
  it("rechecks membership and token revocation every time", async () => {
    let active = true;
    let revoked = false;
    const { auth } = setup({ membership: async () => ({ actor: "user", workspaceId: "workspace", active, purposes: [] }), verifyApiToken: async () => ({ ...token, revoked }) });
    expect(await auth.authenticate(request({ authorization: "Bearer opaque" }))).toMatchObject({ actor: "user", purposes: [] });
    active = false;
    expect(await auth.authenticate(request({ authorization: "Bearer opaque" }))).toMatchObject({ code: "Forbidden" });
    active = true; revoked = true;
    expect(await auth.authenticate(request({ authorization: "Bearer opaque" }))).toMatchObject({ code: "Unauthenticated" });
  });
  it("sanitizes verifier/store errors", async () => {
    for (const overrides of [{ verifyApiToken: async () => { throw Error("secret-token"); } }, { membership: async () => { throw Error("private-database"); } }]) {
      const { auth } = setup(overrides);
      const result = await auth.authenticate(request({ authorization: "Bearer opaque" }));
      expect(result).toMatchObject({ code: "Unauthenticated", detail: "credential verification failed" });
      expect(JSON.stringify(result)).not.toMatch(/secret-token|private-database/);
    }
  });
  it("binds actual HTTP records to the configured tenant and rejects escalation purposes", async () => {
    const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
    const model = new Model(bundle);
    const { auth } = setup();
    const engine = new Engine(model, testLayer(new MemoryStorage()));
    const handler = createHttpHandler(model, engine, { auth });
    const headers = { authorization: "Bearer opaque", "content-type": "application/json", "x-forge-tenant": "evil" };
    const created = await handler(new Request("https://app.test/v1/customers", { method: "POST", headers, body: JSON.stringify({ code: "abc", name: "Example" }) }));
    expect(created.status).toBe(201);
    const record = await created.json();
    expect((await handler(new Request(`https://app.test/v1/customers/${record.id}`, { headers }))).status).toBe(200);
    const { auth: otherAuth } = setup({ workspaceId: "other", verifyApiToken: async () => ({ ...token, workspaceId: "other" }), membership: async () => ({ actor: "user", workspaceId: "other", active: true, purposes: ["read"] }) });
    const otherHandler = createHttpHandler(model, engine, { auth: otherAuth });
    expect((await otherHandler(new Request(`https://app.test/v1/customers/${record.id}`, { headers }))).status).toBe(404);
    const denied = await handler(new Request("https://app.test/v1/customers", { headers: { ...headers, "x-forge-purpose": "admin" } }));
    expect(denied.status).toBe(403);
  });
});

const hostBundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
it("authenticates Node requests and applies membership revocation without restarting", async () => {
  let active = true;
  const { auth } = setup({ membership: async () => ({ actor: "user", workspaceId: "workspace", active, purposes: ["read"] }) });
  const host = createNodeHost({ bundle: hostBundle, store: new MemoryStorage(), auth, cursorSecret: "test", sweepIntervalMs: 0, telemetryFormat: "silent", endpoints: [{ method: "GET", path: "/identity", responseMode: "buffered", handle: async (_request, context) => Response.json(context.principal) }] });
  const base = (await host.listen(0)).url;
  try {
    expect((await fetch(base + "/identity")).status).toBe(401);
    const response = await fetch(base + "/identity", { headers: { authorization: "Bearer opaque", "x-forge-actor": "evil" } });
    expect(await response.json()).toMatchObject({ actor: "user", tenant: "workspace" });
    active = false;
    expect((await fetch(base + "/identity", { headers: { authorization: "Bearer opaque" } })).status).toBe(403);
  } finally { await host.stop(); }
});
it("authenticates the Workers Fetch host without Node credential APIs or D1 access", async () => {
  const { auth } = setup();
  // FORG-3 records each authenticated tenant in the schedule index (system
  // tenant "_forge") off the request path; that is the only D1 access allowed.
  const touched: unknown[] = [];
  const prepare = vi.fn(() => ({ bind: (...params: unknown[]) => { touched.push(params[0]); throw Error("unexpected D1 access"); } }));
  const env = { DB: { prepare }, CURSOR_SECRET: "test" } as unknown as WorkerEnv;
  const worker = createWorker(hostBundle, { auth, endpoints: [{ method: "GET", path: "/identity", responseMode: "buffered", handle: async (_request, context) => Response.json(context.principal) }] });
  const ctx = { waitUntil: vi.fn() };
  expect((await worker.fetch(new Request("https://app.test/identity"), env, ctx)).status).toBe(401);
  const response = await worker.fetch(new Request("https://app.test/identity", { headers: { cookie: "session=valid", "x-forge-tenant": "evil" } }), env, ctx);
  expect(await response.json()).toMatchObject({ actor: "user", tenant: "workspace" });
  expect(touched.filter((tenant) => tenant !== "_forge")).toEqual([]);
});

it("requires a trusted origin for session WebSocket upgrades", async () => {
  const { auth } = setup();
  expect(await auth.authenticate(request({ cookie: "session=valid", upgrade: "websocket", origin: "https://evil.test" }))).toMatchObject({ code: "Forbidden" });
  expect(await auth.authenticate(request({ cookie: "session=valid", upgrade: "websocket", origin: "https://app.test" }))).toMatchObject({ actor: "user" });
});
it("rejects expiration during an asynchronous membership lookup", async () => {
  let clock = now;
  const { auth } = setup({ now: () => clock, membership: async () => { clock += 1000; return { actor: "user", workspaceId: "workspace", active: true, purposes: [] }; } });
  expect(await auth.authenticate(request({ authorization: "Bearer opaque" }))).toMatchObject({ code: "Unauthenticated" });
});
it.each(["null", "*", "https://app.test/path", "https://user:pass@app.test", "data:text/plain,test"])("rejects unsafe allowed origins: %s", origin => {
  expect(() => setup({ sessionOrigins: [origin] })).toThrow();
});
