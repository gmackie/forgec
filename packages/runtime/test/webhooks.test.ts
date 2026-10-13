import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Model, type AppBundle } from "../src/model.js";
import { Engine } from "../src/engine.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { createWorker, type WorkerEnv } from "../src/hosts/cloudflare.js";
import { createNodeHost } from "../src/hosts/node.js";
import { createHttpHandler, devHeaderAuth } from "../src/http.js";

const model = new Model(JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/acme.app.json"), "utf8")) as AppBundle);
const secret = "test-webhook-secret-with-at-least-32-bytes";
async function signature(body: Uint8Array, key = secret) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new Uint8Array(body)));
  return "sha256=" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
const body = new TextEncoder().encode('{ "message": "☃", "sequence": 1 }\n');
function setup(maxBodyBytes = 1024, getSecret = async () => secret) {
  const deliver = vi.fn(async (_req: Request, raw: Uint8Array) => new Response(new Uint8Array(raw), { status: 202 }));
  const auth = { ...devHeaderAuth(), authenticate: vi.fn(devHeaderAuth().authenticate) };
  const handler = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), {
    auth, webhooks: { "/hooks/forgejo": { secret: getSecret, maxBodyBytes, handle: deliver } },
  });
  return { handler, deliver, auth };
}
function request(signature?: string, bytes = body, path = "/hooks/forgejo") {
  return new Request("https://api.test" + path, { method: "POST", body: bytes, headers: signature ? { "x-hub-signature-256": signature } : {} });
}
describe("signed webhook HTTP boundary", () => {
  it("verifies the exact non-normalized bytes before invoking a webhook without session auth", async () => {
    const { handler, deliver, auth } = setup();
    const response = await handler(request(await signature(body)));
    expect(response.status).toBe(202);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(deliver).toHaveBeenCalledOnce();
    expect(auth.authenticate).not.toHaveBeenCalled();
  });
  it("rejects missing, malformed, wrong-key and changed-body signatures before delivery", async () => {
    const { handler, deliver } = setup();
    for (const sig of [undefined, "sha256=xyz", await signature(body, secret + "wrong"), await signature(new TextEncoder().encode('{}'))]) {
      expect((await handler(request(sig))).status).toBe(401);
    }
    expect(deliver).not.toHaveBeenCalled();
  });
  it("enforces byte limits while reading a stream without Content-Length", async () => {
    const { handler, deliver } = setup(5);
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(body); }, cancel() { cancelled = true; } });
    const req = new Request("https://api.test/hooks/forgejo", { method: "POST", headers: { "x-hub-signature-256": await signature(body) }, body: stream, duplex: "half" } as RequestInit);
    expect((await handler(req)).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("preserves session auth for wrong methods, sibling paths and normal API routes", async () => {
    const { handler, deliver, auth } = setup();
    for (const req of [new Request("https://api.test/hooks/forgejo"), request(await signature(body), body, "/hooks/forgejo/extra"), request(await signature(body), body, "/v1/customers")]) {
      expect((await handler(req)).status).toBe(401);
    }
    expect(auth.authenticate).toHaveBeenCalledTimes(3);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("reloads the private secret on every request and fails closed without exposing secret-store errors", async () => {
    let key = secret;
    const { handler, deliver } = setup(1024, async () => key);
    expect((await handler(request(await signature(body)))).status).toBe(202);
    key += "rotated";
    expect((await handler(request(await signature(body)))).status).toBe(401);
    expect((await handler(request(await signature(body, key)))).status).toBe(202);
    const unavailable = setup(1024, async () => { throw Error("private store information"); });
    const res = await unavailable.handler(request(await signature(body)));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("private store information");
    expect(deliver).toHaveBeenCalledTimes(2);
  });
});


it("wires signed webhooks through the real Node host without opening domain routes", async () => {
  const host = createNodeHost({ bundle: model.bundle, store: new MemoryStorage(), cursorSecret: "webhook-test", telemetryFormat: "silent", sweepIntervalMs: 0,
    auth: { authenticate: async () => (await devHeaderAuth().authenticate(new Request("https://test"))) },
    webhooks: { "/hooks/forgejo": { secret: async () => secret, handle: async (_req, raw) => new Response(new Uint8Array(raw), { status: 202 }) } },
  });
  const { url } = await host.listen();
  try {
    const response = await fetch(url + "/hooks/forgejo", { method: "POST", body, headers: { "x-hub-signature-256": await signature(body) } });
    expect(response.status).toBe(202);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect((await fetch(url + "/v1/customers")).status).toBe(401);
  } finally { await host.stop(); }
});

it("rejects unsafe webhook configuration and redacts callback failures", async () => {
  for (const path of ["hooks/test", "/hooks/../test", "/hooks/test?query", "//other.test/hooks"]) {
    expect(() => createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), { auth: devHeaderAuth(), webhooks: {
      [path]: { secret: async () => secret, handle: async () => new Response() },
    } })).toThrow();
  }
  const handler = createHttpHandler(model, new Engine(model, testLayer(new MemoryStorage())), { auth: devHeaderAuth(), webhooks: {
    "/hooks/forgejo": { secret: async () => secret, handle: async () => { throw Error("private processing details"); } },
  } });
  const response = await handler(request(await signature(body)));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private processing details");
});


it("binds Worker secrets from env and never infers a domain sweep tenant from a signed webhook", async () => {
  const prepare = vi.fn(() => { throw Error("webhook must not touch domain storage"); });
  const env = { DB: { prepare }, CURSOR_SECRET: "test", WEBHOOK_SECRET: secret } as unknown as WorkerEnv;
  const auth = { ...devHeaderAuth(), authenticate: vi.fn(devHeaderAuth().authenticate) };
  const worker = createWorker(model.bundle, { auth, webhooks: env => ({
    "/hooks/forgejo": { secret: async () => env.WEBHOOK_SECRET as string, handle: async (_req, raw) => new Response(new Uint8Array(raw), { status: 202 }) },
  }) });
  const req = request(await signature(body));
  req.headers.set("x-forge-tenant", "untrusted-sender-tenant");
  const ctx = { waitUntil: vi.fn() };
  const response = await worker.fetch(req, env, ctx);
  expect(response.status).toBe(202);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  expect(auth.authenticate).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(ctx.waitUntil).not.toHaveBeenCalled();
});
