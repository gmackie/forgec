// The host Worker under `wrangler dev --local` (workerd with the Worker Loader), linking acme.
// Tests run in order against one host: each links the manifest it needs.
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClosureManifest } from "../src/manifest.ts";
import { acmeManifest, acmeManifestText, entry, h, hostileAdapter, rehash, sealVariant, stableJson } from "./fixtures.ts";

const PORT = 8951;
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
  host = await h.startWorker({ kind: "host", port: PORT });
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
    const changesets = await call("POST", "/v1/changesets", { changes: [] });
    expect(changesets.json.code).toBe("UnknownEntryPoint");
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
    expect(probe["envKeys"]).toEqual(["CURSOR_SECRET", "DB", "FORGE_AUTH", "Q_FULFILL_ORDER"]);
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
    // The runtime reports the refused statement as a storage failure, not as a domain error.
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("StorageUnavailable");
    expect((await call("GET", `/v1/orders/${order}`)).json.status).toBe("Draft");
    expect((await h.stats(host.base)).denials.some((d) => d.includes(`http-route:${SUBMIT} has no capability to write order_`))).toBe(true);
  });

  it("a manifest swap re-links only the closures whose implementation changed", async () => {
    expect((await link(acmeManifestText())).status).toBe(200);
    const order = await draftOrder("SWP1");
    await call("GET", "/v1/customers");
    const before = await call("POST", `/v1/orders/${order}/submit`, { expectedVersion: 1 });
    expect(before.status).toBe(200);
    const r = await link(swapped.text, join(swapped.dir, "modules"));
    expect(r.status).toBe(200);
    expect(r.body["previous"]).toBe(acmeManifest().manifestHash);
    // Only AuthorizePayment's module is new; every other blob is byte-identical.
    expect(Object.keys(swapped.manifest.modules).filter((b) => !acmeManifest().modules[b])).toHaveLength(1);
    const changed = swapped.manifest.entryPoints.filter((e) => e.closureHash !== entry(acmeManifest(), e.id).closureHash).map((e) => e.id).sort();
    expect(changed).toContain(SUBMIT);
    expect(changed).not.toContain("GET /v1/customers");
    expect(changed).toEqual(acmeManifest().entryPoints.filter((e) => e.closure.some((u) => acmeManifest().units[u]!.symbol === "@acme/payments/_/AuthorizePayment")).map((e) => e.id).sort());
    expect((await call("GET", "/v1/customers")).isolate).toBe("warm");
    const big = await draftOrder("SWP2", "1500.00");
    const after = await call("POST", `/v1/orders/${big}/submit`, { expectedVersion: 1 });
    expect(after.isolate).toBe("cold");
    expect(after.closure).toBe(entry(swapped.manifest, SUBMIT).closureHash);
    // 1500 is declined by the original adapter (limit 1000) and authorized by the swapped one (limit 2000).
    expect(after.status).toBe(200);
  });
});
