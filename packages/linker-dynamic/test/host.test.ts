// The host Worker under `wrangler dev --local` (workerd with the Worker Loader), linking acme.
// Tests run in order against one host: each links the manifest it needs.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClosureManifest } from "../src/manifest.ts";
import { acmeManifest, acmeManifestText, entry, h, hostileAdapter, rehash, sealVariant, stableJson } from "./fixtures.ts";

const SUBMIT = "POST /v1/orders/{order}/submit";
let host: Awaited<ReturnType<typeof h.startWorker>>;
let egressServer: Server;
let egressOrigin = "";
let hostile: Awaited<ReturnType<typeof sealVariant>>;
let swapped: Awaited<ReturnType<typeof sealVariant>>;

const tenant = `t-${Math.random().toString(36).slice(2, 8)}`;
const H = { "x-forge-tenant": tenant, "x-forge-actor": "tester", "content-type": "application/json" };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${host.base}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, isolate: r.headers.get("x-forge-isolate"), closure: r.headers.get("x-forge-closure"), entry: r.headers.get("x-forge-entry") };
};
const link = (m: ClosureManifest | string, modulesDir?: string, skipModules: string[] = []) =>
  h.linkManifest(host.base, { manifestText: typeof m === "string" ? m : stableJson(m), ...(modulesDir ? { modulesDir } : {}), skipModules });

/** A fresh customer, enabled site and draft order (subtotal + 1.00 tax). */
async function draftOrder(code: string, subtotal = "10.00") {
  const c = await call("POST", "/v1/customers", { code, name: "Probe" });
  const s = await call("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
  const o = await call("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal, tax: "1.00", requestedOn: "2026-09-20" });
  expect(o.status).toBe(201);
  return o.json.id as string;
}

beforeAll(async () => {
  h.prepare();
  egressServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("egress-target");
  });
  await new Promise<void>((r) => egressServer.listen(0, "127.0.0.1", r));
  egressOrigin = `http://127.0.0.1:${(egressServer.address() as AddressInfo).port}`;
  hostile = await sealVariant((impl) => writeFileSync(join(impl, "payment-adapter.ts"), hostileAdapter(`${egressOrigin}/probe`)));
  swapped = await sealVariant((impl) => {
    const f = join(impl, "payment-adapter.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace("amount >= 1e3", "amount >= 2e3").replace("amount >= 1000", "amount >= 2000"));
  });
  host = await h.startWorker({ kind: "host" }); // a free port (FORG-45)
  await h.seedKit(host.base);
}, 240_000);

afterAll(async () => {
  await host?.stop();
  egressServer?.close();
});

describe("Linker B host on local workerd", () => {
  it("links the sealed acme manifest and serves it through child isolates", async () => {
    const r = await link(acmeManifestText());
    expect(r.status).toBe(200);
    expect(r.body["manifestHash"]).toBe(acmeManifest().manifestHash);
    const first = await call("GET", "/v1/customers");
    expect(first.status).toBe(200);
    expect(first.isolate).toBe("cold");
    expect(first.entry).toBe("GET /v1/customers");
    expect(first.closure).toBe(entry(acmeManifest(), "GET /v1/customers").closureHash);
    const second = await call("GET", "/v1/customers");
    expect(second.isolate).toBe("warm");
    const order = await draftOrder("ACME1");
    const submitted = await call("POST", `/v1/orders/${order}/submit`, { expectedVersion: 1 });
    expect(submitted.status).toBe(200);
    expect(submitted.json.status).toBe("Submitted");
    const got = await call("GET", `/v1/orders/${order}`);
    expect(got.json.status).toBe("Submitted");
    expect((await h.stats(host.base)).denials).toEqual([]);
  });

  it("refuses a request no entry point claims", async () => {
    const r = await call("GET", "/v1/not-a-route");
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("UnknownEntryPoint");
    // FORG-33: changesets were refused here before; they are an entry point with their own closure now.
    const changesets = await call("POST", "/v1/changesets", { mode: "atomic", operations: [] });
    expect(changesets.entry).toBe("POST /v1/changesets");
    expect(changesets.json.code).not.toBe("UnknownEntryPoint");
    // A method no entry point serves on a known path runs in that path's child: the runtime answers 405.
    const wrong = await call("DELETE", "/v1/customers");
    expect([wrong.status, wrong.json.code]).toEqual([405, "MethodNotAllowed"]);
    const preflight = await fetch(`${host.base}/v1/customers`, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    expect([preflight.status, preflight.headers.get("access-control-allow-origin")]).toEqual([204, "http://localhost:5173"]);
    // The upgrade route is an entry point now, but the realtime Durable Object is still not linked.
    const ws = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(`${host.base}/v1/live/orders`, { headers: { ...H, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("upgrade", () => reject(new Error("upgraded")));
      req.on("error", reject);
      req.end();
    });
    expect(ws.status).toBe(501);
    expect((JSON.parse(ws.body) as { code: string }).code).toBe("UnlinkedEntryPoint");
  });

  it("refuses at link time a manifest whose module bytes are missing, and keeps serving the previous one", async () => {
    const before = (await h.stats(host.base)).manifestHash;
    const authorize = Object.values(hostile.manifest.units).find((u) => u.symbol === "@acme/payments/_/AuthorizePayment")!;
    const blob = (authorize.implementation as { module: string }).module;
    const r = await link(hostile.text, join(hostile.dir, "modules"), [blob]);
    expect(r.status).toBe(503);
    expect(r.body["code"]).toBe("MissingModule");
    expect(String(r.body["detail"])).toContain(blob);
    expect((await h.stats(host.base)).manifestHash).toBe(before);
    expect((await call("GET", "/v1/customers")).status).toBe(200);
  });

  it("refuses a manifest that does not match its hash", async () => {
    const m = acmeManifest();
    entry(m, "GET /v1/customers").imports = [];
    const r = await link(m);
    expect(r.status).toBe(422);
    expect(r.body["code"]).toBe("ManifestHashMismatch");
  });

  it("sandbox: a child sees only its stubs, has no network, and reaches only its closure's tables", async () => {
    expect((await link(hostile.text, join(hostile.dir, "modules"))).status).toBe(200);
    const order = await draftOrder("SBX1");
    const r = await call("POST", `/v1/orders/${order}/submit`, { expectedVersion: 1 });
    expect(r.json.code).toBe("@acme/commerce/_/SubmitOrder.PaymentUnavailable");
    const probe = JSON.parse(r.json.detail) as Record<string, unknown>;
    // Capability stubs and the manifest's host vars, nothing else: no LOADER, UNITS, BLOBS, workflow binding, admin token.
    expect(probe["envKeys"]).toEqual(["CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS", "Q_FULFILL_ORDER"]);
    expect(probe["hostGlobals"]).toEqual([]);
    expect(probe["blobs"]).toBe("undefined");
    expect(String(probe["fetch"])).toMatch(/^threw:.*not permitted to access the internet/);
    expect(String(probe["fetchOther"])).toMatch(/^threw:/);
    expect(probe["readOrder"]).toBe("allowed");
    expect(probe["readSite"]).toBe("allowed");
    expect(probe["readSystem"]).toBe("allowed");
    expect(String(probe["readDepartment"])).toMatch(/^denied:.*no capability to read department/);
    expect(String(probe["readSitePolicy"])).toMatch(/^denied:.*read site_policy/);
    expect(String(probe["writeSite"])).toMatch(/^denied:.*write site/);
    expect(String(probe["sqliteMaster"])).toMatch(/^denied:.*read sqlite_master/);
    expect(String(probe["pragma"])).toMatch(/^denied:.*unclassified/);
    const s = await h.stats(host.base);
    expect(s.denials.some((d) => d.includes(`http-route:${SUBMIT} has no capability to read department`))).toBe(true);
  });

  it("egress: a declared origin is reachable through the host's gateway, every other origin is refused", async () => {
    const m = JSON.parse(hostile.text) as ClosureManifest;
    entry(m, SUBMIT).egress = [egressOrigin];
    expect((await link(rehash(m, { closures: false }), join(hostile.dir, "modules"))).status).toBe(200);
    const order = await draftOrder("EGR1");
    const r = await call("POST", `/v1/orders/${order}/submit`, { expectedVersion: 1 });
    const probe = JSON.parse(r.json.detail) as Record<string, unknown>;
    expect(probe["fetch"]).toBe("status:200:egress-target");
    expect(probe["fetchOther"]).toBe("status:403:denied");
    expect((await h.stats(host.base)).denials.some((d) => d.includes("has no egress to https://example.com"))).toBe(true);
  });

  it("an undeclared capability fails closed", async () => {
    // Dropping Site#read would not do: the reference guard on Order writes already implies a read
    // of site (README, "Sandbox"). Dropping Order#write leaves the transition without its table.
    const m = acmeManifest();
    const submit = entry(m, SUBMIT);
    submit.imports = submit.imports.filter((i) => i.capability !== "resource:@acme/commerce/_/Order#write");
    expect((await link(rehash(m, { closures: false }))).status).toBe(200);
    await h.resetStats(host.base);
    const order = await draftOrder("UND1");
    const r = await call("POST", `/v1/orders/${order}/submit`, { expectedVersion: 1 });
    // FORG-34: a policy denial, not an outage (it was 503 StorageUnavailable, and retried).
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: "CapabilityDenied", retryable: false, capability: "resource:@acme/commerce/_/Order#write", entryPoint: `http-route:${SUBMIT}` });
    expect((await call("GET", `/v1/orders/${order}`)).json.status).toBe("Draft");
    expect((await h.stats(host.base)).denials.some((d) => d.includes(`http-route:${SUBMIT} has no capability to write order_`))).toBe(true);
  });

  it("a handle declared for other entry points is refused, not silently replaced (FORG-34)", async () => {
    // finalize reads the uploaded bytes from BLOBS. Without its r2 binding the runtime used to fall
    // back to an in-memory object store and answer 422 (no bytes); now the child's stub refuses it.
    const finalize = async (code: string) => {
      const c = await call("POST", "/v1/customers", { code, name: "Blob" });
      const s = await call("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
      const o = await call("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" });
      const doc = await call("POST", "/v1/order-documents", { order: o.json.id, kind: "quote", label: "Q1" });
      expect(doc.status).toBe(201);
      const begin = await fetch(`${host.base}/v1/order-documents/${doc.json.id}/upload`, { method: "POST", headers: { ...H, "if-match": '"1"' }, body: JSON.stringify({ expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }) });
      expect(begin.status).toBe(200);
      const r = await fetch(`${host.base}/v1/order-documents/${doc.json.id}/finalize`, { method: "POST", headers: { ...H, "if-match": '"2"' }, body: JSON.stringify({ expectedVersion: 2 }) });
      return { status: r.status, json: (await r.json()) as Record<string, unknown> };
    };
    expect((await link(acmeManifestText())).status).toBe(200);
    const declared = await finalize("BLB1");
    expect(declared.status).toBe(422);
    expect(declared.json["code"]).toBe("ValidationFailed");
    const m = acmeManifest();
    const route = entry(m, "POST /v1/order-documents/{id}/finalize");
    route.bindings = route.bindings.filter((b) => b.name !== "BLOBS");
    expect((await link(rehash(m, { closures: false }))).status).toBe(200);
    const withheld = await finalize("BLB2");
    expect(withheld.status).toBe(403);
    expect(withheld.json).toMatchObject({ code: "CapabilityDenied", capability: "binding:r2:BLOBS", entryPoint: "http-route:POST /v1/order-documents/{id}/finalize" });
  });

  it("dispatch: a narrowed child never marks another closure's delivery done; the dispatch child delivers it", async () => {
    // POST /v1/orders runs in a child whose model lacks the CustomerOrderSummary projection that
    // consumes Order.changes. Had that child swept the outbox in-process, the row would be marked
    // delivered with no subscriber (packages/runtime/test/host-dispatch.test.ts, "why"), and it would
    // never reach the projection. The host hands the nudge to the runtime's dispatch() in the
    // whole-app dispatch child instead, so the row ends delivered *to the projection*.
    expect((await link(acmeManifestText())).status).toBe(200);
    const m = acmeManifest();
    expect(entry(m, "POST /v1/orders").closure.some((u) => m.units[u]!.symbol.includes("CustomerOrderSummary"))).toBe(false);
    await h.resetStats(host.base);
    const t = `d-${Math.random().toString(36).slice(2, 8)}`;
    const post = async (path: string, body: unknown) => (await fetch(`${host.base}${path}`, { method: "POST", headers: { ...H, "x-forge-tenant": t }, body: JSON.stringify(body) })).json() as Promise<{ id: string }>;
    const c = await post("/v1/customers", { code: "DSP1", name: "Dispatch" });
    const s = await post("/v1/sites", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await fetch(`${host.base}/v1/orders`, { method: "POST", headers: { ...H, "x-forge-tenant": t }, body: JSON.stringify({ customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" }) });
    expect(o.status).toBe(201);
    expect(o.headers.get("x-forge-linker")).toBeNull(); // served by the narrowed child, not a fallback
    const d1Dir = join(host.state, "v3", "d1", "miniflare-D1DatabaseObject");
    const file = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite"))!;
    const rows = () => {
      const db = new DatabaseSync(join(d1Dir, file), { readOnly: true });
      try {
        return db.prepare("SELECT status, delivered, attempts FROM forge_outbox WHERE tenant = ? AND channel = '@acme/commerce/_/Order.changes'").all(t) as Array<{ status: string; delivered: string | null; attempts: number }>;
      } finally {
        db.close();
      }
    };
    const until = Date.now() + 30_000;
    while (rows()[0]?.status !== "delivered" && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    const [row] = rows();
    expect(row?.status).toBe("delivered");
    expect((JSON.parse(row!.delivered ?? "[]") as string[]).some((sub) => sub.includes("CustomerOrderSummary"))).toBe(true);
    // Claimed once, by the dispatch child; the request children never tried a delivery they cannot make.
    expect(row!.attempts).toBe(1);
    expect((await h.stats(host.base)).denials).toEqual([]);
  });

  it("FORG-48: a loader miss reads a closure's blobs from the isolate's memory, then the Cache API, verified", async () => {
    expect((await link(acmeManifestText())).status).toBe(200);
    const breakdown = async (layers: string) => {
      const ev = await fetch(`${host.base}/_linker/evict-host-cache?layers=${layers}`, { method: "POST", headers: { "x-linker-admin": "local-linker-admin" } });
      expect(ev.status).toBe(200);
      const r = await fetch(`${host.base}/v1/customers`, { headers: H });
      expect(r.status).toBe(200);
      await r.arrayBuffer();
      expect(r.headers.get("x-forge-isolate")).toBe("cold"); // the eviction bumps the child id: a loader miss
      return Object.fromEntries((r.headers.get("x-forge-link-breakdown") ?? "").split(";").map((kv) => kv.split("=")));
    };
    await (await fetch(`${host.base}/v1/customers`, { headers: H })).arrayBuffer(); // fills the memory layer
    // Code cache dropped, memory kept: every blob (runtime, Effect, app.json, units) from memory.
    const fromMemory = await breakdown("code");
    expect(fromMemory).toMatchObject({ fetch: "memory,cache,parallel", store: "0", cache: "0" });
    expect(Number(fromMemory["memory"])).toBeGreaterThanOrEqual(3);
    // Memory dropped too: what a new host isolate in the same colo sees, from the Cache API.
    const fromCache = await breakdown("code,memory");
    expect(fromCache).toMatchObject({ store: "0", memory: "0" });
    expect(Number(fromCache["cache"])).toBeGreaterThanOrEqual(3);
    // Cache API entries dropped too: the unit store, verified, in parallel.
    const fromStore = await breakdown("code,memory,cache");
    expect(fromStore).toMatchObject({ cache: "0", memory: "0" });
    expect(Number(fromStore["store"])).toBeGreaterThanOrEqual(3);
    // Warm again afterwards: no build at all.
    const warm = await fetch(`${host.base}/v1/customers`, { headers: H });
    await warm.arrayBuffer();
    expect(warm.headers.get("x-forge-isolate")).toBe("warm");
    expect(warm.headers.get("x-forge-link-breakdown")).not.toContain("fetch=");
  });

  it("a manifest swap re-links only the closures whose implementation changed", async () => {
    expect((await link(acmeManifestText())).status).toBe(200);
    const order = await draftOrder("SWP1");
    await call("GET", "/v1/customers");
    const before = await call("POST", `/v1/orders/${order}/submit`, { expectedVersion: 1 });
    expect(before.status).toBe(200);
    const r = await link(swapped.text, join(swapped.dir, "modules"));
    expect(r.status).toBe(200);
    // Parse the acme manifest once (FORG-45): re-reading it per entry point and per closure unit
    // took seconds of synchronous CPU, and past 5 s of a blocked event loop the next request
    // went out on a keep-alive socket workerd had already closed (ECONNRESET).
    const acme = acmeManifest();
    expect(r.body["previous"]).toBe(acme.manifestHash);
    // Only AuthorizePayment's module is new; every other blob is byte-identical.
    expect(Object.keys(swapped.manifest.modules).filter((b) => !acme.modules[b])).toHaveLength(1);
    const changed = swapped.manifest.entryPoints.filter((e) => e.closureHash !== entry(acme, e.id).closureHash).map((e) => e.id).sort();
    expect(changed).toContain(SUBMIT);
    expect(changed).not.toContain("GET /v1/customers");
    expect(changed).toEqual(acme.entryPoints.filter((e) => e.closure.some((u) => acme.units[u]!.symbol === "@acme/payments/_/AuthorizePayment")).map((e) => e.id).sort());
    expect((await call("GET", "/v1/customers")).isolate).toBe("warm");
    const big = await draftOrder("SWP2", "1500.00");
    const after = await call("POST", `/v1/orders/${big}/submit`, { expectedVersion: 1 });
    expect(after.isolate).toBe("cold");
    expect(after.closure).toBe(entry(swapped.manifest, SUBMIT).closureHash);
    // 1500 is declined by the original adapter (limit 1000) and authorized by the swapped one (limit 2000).
    expect(after.status).toBe(200);
  });
});
