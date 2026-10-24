// Linker C on local workerd (Miniflare): the tiered router, the tier host with a Worker Loader, and
// linker A's 87 packed scripts in one instance. Tests run in order against one deployment; each says
// which dynamic manifest it links.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TieredLink } from "../src/link.ts";
import { linkDynamic, resetTierStats, tierStats } from "../src/local.ts";
import { acmeManifest, acmeManifestText, breakModule, linkAcme, prepare, raiseLimit, scriptDigests, sealVariant, serveTier, unitsOut, type Tier } from "./fixtures.ts";

const SUBMIT = "POST /v1/orders/{order}/submit";
let out = "";
let t: TieredLink;
let tier: Tier;
let swapped: Awaited<ReturnType<typeof sealVariant>>;
let broken: Awaited<ReturnType<typeof sealVariant>>;

const tenant = `c-${Math.random().toString(36).slice(2, 8)}`;
const H = { "x-forge-tenant": tenant, "x-forge-actor": "tester", "content-type": "application/json" };
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${tier.served.url}${path}`, { method, headers: { ...H, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, tier: r.headers.get("x-forge-tier"), miss: r.headers.get("x-forge-tier-miss"), entry: r.headers.get("x-forge-entry"), closure: r.headers.get("x-forge-closure") };
}
const link = (text: string, modulesDir = join(unitsOut, "modules")) => linkDynamic(tier.host, { manifestText: text, modulesDir, known: tier.known });
const hostStats = async () => (await tier.host.fetch("/_linker/stats")).json() as Promise<{ manifestHash: string; closures: Array<{ label: string; closureHash: string; cold: number; warm: number }>; denials: string[] }>;
const tierHost = async () => (await tier.host.fetch("/_linker/tier")).json() as Promise<{ stats: { workflowAdvances: { dynamic: number; fallback: number }; fallbacks: Array<{ reason: string }> } }>;

/** A fresh customer, enabled site and draft order. */
async function draftOrder(code: string, subtotal = "10.00") {
  const c = await call("POST", "/v1/customers", { code, name: "Probe" });
  const s = await call("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
  const o = await call("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal, tax: "1.00", requestedOn: "2026-09-20" });
  expect(o.status).toBe(201);
  return { id: o.json.id as string, create: o };
}

beforeAll(async () => {
  prepare();
  out = mkdtempSync(join(tmpdir(), "forg43-tiered-"));
  t = await linkAcme(out);
  swapped = await sealVariant(raiseLimit);
  broken = await sealVariant(breakModule);
  tier = await serveTier(t, out);
}, 600_000);

afterAll(async () => {
  await tier?.close();
});

describe("linker C on local workerd", () => {
  it("serves dynamic entry points from the dynamic host and every other entry point packed", async () => {
    await resetTierStats(tier.served);
    const list = await call("GET", "/v1/customers");
    expect([list.status, list.tier]).toEqual([200, "packed"]);
    const { id, create } = await draftOrder("TIER1");
    expect(create.tier).toBe("dynamic");
    expect(create.entry).toBe("POST /v1/orders");
    const sub = await call("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
    expect([sub.status, sub.json.status, sub.tier]).toEqual([200, "Submitted", "dynamic"]);
    expect(sub.closure).toBe(acmeManifest().entryPoints.find((e) => e.id === SUBMIT)!.closureHash);
    const got = await call("GET", `/v1/orders/${id}`);
    expect([got.json.status, got.tier]).toEqual(["Submitted", "packed"]);
    const st = await tierStats(tier.served);
    expect(st.fallback).toBe(0);
    expect(st.dynamic).toBe(2);
  });

  it("has one dispatch owner: a dynamic write is delivered once, by linker A's sweep script, never by a dispatch child", async () => {
    // POST /v1/orders runs in a child without the CustomerOrderSummary projection that consumes Order.changes.
    const m = acmeManifest();
    expect(m.entryPoints.find((e) => e.id === "POST /v1/orders")!.closure.some((u) => m.units[u]!.symbol.includes("CustomerOrderSummary"))).toBe(false);
    const { id, create } = await draftOrder("DSP1");
    expect(create.tier).toBe("dynamic");
    const db = await tier.served.mf.getD1Database("DB", t.host.name);
    const rows = async () => (await db.prepare("SELECT status, delivered, attempts FROM forge_outbox WHERE tenant = ? AND channel = '@acme/commerce/_/Order.changes' AND payload LIKE ?").bind(tenant, `%${id}%`).all<{ status: string; delivered: string | null; attempts: number }>()).results;
    const until = Date.now() + 30_000;
    while ((await rows())[0]?.status !== "delivered" && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    const [row] = await rows();
    expect(row?.status).toBe("delivered");
    expect((JSON.parse(row!.delivered ?? "[]") as string[]).some((sub) => sub.includes("CustomerOrderSummary"))).toBe(true);
    expect(row!.attempts).toBe(1);
    // The dynamic host made no dispatch child: it handed the nudge to the sweep script.
    const st = await hostStats();
    expect(st.closures.map((c) => c.label)).not.toContain("runtime:dispatch");
    expect(t.host.services["FORGE_DISPATCH"]).toBe(t.packed.dispatchOwner);
  });

  it("runs a dynamic workflow's driver steps in the dynamic host", async () => {
    const before = (await tierHost()).stats.workflowAdvances;
    const { id } = await draftOrder("WFD1");
    const start = await call("POST", `/v1/orders/${id}/process`, { expectedVersion: 1 });
    expect([start.status, start.tier, start.json.status]).toEqual([200, "dynamic", "waiting"]);
    const signal = await call("POST", "/v1/workflows/process-order/signals/PaymentCaptured", { messageId: `pay-${id}`, payload: { authorizationId: "auth_t", reference: id, amount: "11.00" } });
    expect([signal.json.delivered, signal.tier]).toEqual([1, "dynamic"]);
    let wf = await call("GET", `/v1/workflows/process-order/${start.json.id}`);
    for (let n = 0; n < 60 && wf.json.status !== "completed"; n++) {
      await new Promise((r) => setTimeout(r, 500));
      wf = await call("GET", `/v1/workflows/process-order/${start.json.id}`);
    }
    expect([wf.json.status, wf.json.output?.status]).toEqual(["completed", "Approved"]);
    const after = (await tierHost()).stats.workflowAdvances;
    expect(after.dynamic).toBeGreaterThan(before.dynamic);
    expect(after.fallback).toBe(before.fallback);
    expect((await hostStats()).closures.some((c) => c.label === "workflow:@acme/commerce/_/ProcessOrder")).toBe(true);
  });

  it("answers a capability denial in the dynamic tier, and does not fall back on it", async () => {
    const m = acmeManifest();
    const submit = m.entryPoints.find((e) => e.id === SUBMIT)!;
    submit.imports = submit.imports.filter((i) => i.capability !== "resource:@acme/commerce/_/Order#write");
    const { stableJson, digest } = await import("@forgegraph/units");
    const { manifestHash: _, ...body } = m;
    expect((await link(stableJson({ ...body, manifestHash: digest("forge:closure-manifest:", body) }))).status).toBe(200);
    await resetTierStats(tier.served);
    const { id } = await draftOrder("CAP1");
    const r = await call("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
    expect([r.status, r.tier, r.miss]).toEqual([403, "dynamic", null]);
    expect(r.json).toMatchObject({ code: "CapabilityDenied", capability: "resource:@acme/commerce/_/Order#write", entryPoint: `http-route:${SUBMIT}` });
    expect((await call("GET", `/v1/orders/${id}`)).json.status).toBe("Draft");
    expect((await tierStats(tier.served)).fallback).toBe(0);
    expect((await link(acmeManifestText())).status).toBe(200);
  });

  it("swaps a dynamic closure without re-uploading any script, and serves the new behaviour", async () => {
    const scripts = scriptDigests(out);
    const big = await draftOrder("SWP1", "1500.00");
    const declined = await call("POST", `/v1/orders/${big.id}/submit`, { expectedVersion: 1 });
    expect([declined.tier, declined.json.code]).toEqual(["dynamic", "@acme/commerce/_/SubmitOrder.PaymentDeclined"]);
    const r = await link(swapped.text, join(swapped.dir, "modules"));
    expect(r.status).toBe(200);
    expect(r.body["previous"]).toBe(acmeManifest().manifestHash);
    // The whole deploy: one module blob and the manifest, into the dynamic tier's unit store.
    expect(r.uploaded.map((u) => u.what)).toEqual(["module"]);
    expect(Object.keys(swapped.manifest.modules).filter((b) => !acmeManifest().modules[b])).toEqual(r.uploaded.map((u) => u.digest));
    expect(scriptDigests(out)).toEqual(scripts);
    const big2 = await draftOrder("SWP2", "1500.00");
    const authorized = await call("POST", `/v1/orders/${big2.id}/submit`, { expectedVersion: 1 });
    expect([authorized.status, authorized.tier, authorized.json.status]).toEqual([200, "dynamic", "Submitted"]);
    expect(authorized.closure).toBe(swapped.manifest.entryPoints.find((e) => e.id === SUBMIT)!.closureHash);
    expect(authorized.closure).not.toBe(acmeManifest().entryPoints.find((e) => e.id === SUBMIT)!.closureHash);
  });

  it("falls back to the packed script when a dynamic child cannot load, and reports it", async () => {
    expect((await link(broken.text, join(broken.dir, "modules"))).status).toBe(200);
    await resetTierStats(tier.served);
    const { id, create } = await draftOrder("FBK1");
    // POST /v1/orders does not hold AuthorizePayment: its child loads.
    expect(create.tier).toBe("dynamic");
    const r = await call("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
    expect([r.status, r.json.status, r.tier, r.miss]).toEqual([200, "Submitted", "packed-fallback", "LoadFailed"]);
    // The packed script holds the implementation it was linked with: the 1000 limit.
    const big = await draftOrder("FBK2", "1500.00");
    const declined = await call("POST", `/v1/orders/${big.id}/submit`, { expectedVersion: 1 });
    expect([declined.tier, declined.json.code]).toEqual(["packed-fallback", "@acme/commerce/_/SubmitOrder.PaymentDeclined"]);
    const st = await tierStats(tier.served);
    expect(st.fallback).toBe(2);
    expect(st.byReason).toEqual({ LoadFailed: 2 });
    expect(st.byEntryPoint).toEqual({ [SUBMIT]: 2 });
  });

  it("falls back per driver step when a dynamic workflow cannot load", async () => {
    const before = (await tierHost()).stats.workflowAdvances;
    const { id } = await draftOrder("WFF1");
    const start = await call("POST", `/v1/orders/${id}/process`, { expectedVersion: 1 });
    expect([start.status, start.tier, start.miss, start.json.status]).toEqual([200, "packed-fallback", "LoadFailed", "waiting"]);
    const signal = await call("POST", "/v1/workflows/process-order/signals/PaymentCaptured", { messageId: `pay-${id}`, payload: { authorizationId: "auth_f", reference: id, amount: "11.00" } });
    expect([signal.json.delivered, signal.tier]).toEqual([1, "packed-fallback"]);
    let wf = await call("GET", `/v1/workflows/process-order/${start.json.id}`);
    for (let n = 0; n < 60 && wf.json.status !== "completed"; n++) {
      await new Promise((r) => setTimeout(r, 500));
      wf = await call("GET", `/v1/workflows/process-order/${start.json.id}`);
    }
    expect([wf.json.status, wf.json.output?.status]).toEqual(["completed", "Approved"]);
    const h = (await tierHost()).stats;
    expect(h.workflowAdvances.fallback).toBeGreaterThan(before.fallback);
    expect(h.fallbacks.at(-1)!.reason).toBe("LoadFailed");
  });

  it("falls back when a module is missing from the unit store", async () => {
    expect((await link(acmeManifestText())).status).toBe(200);
    const blob = (Object.values(acmeManifest().units).find((u) => u.symbol === "@acme/payments/_/AuthorizePayment")!.implementation as { module: string }).module;
    const units = await tier.served.mf.getR2Bucket("UNITS", t.host.name);
    await units.delete(`blobs/${blob.slice("sha256:".length)}`);
    await tier.host.fetch("/_linker/evict-host-cache", { method: "POST" });
    await resetTierStats(tier.served);
    const { id } = await draftOrder("MSS1");
    const r = await call("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
    expect([r.status, r.tier, r.miss]).toEqual([200, "packed-fallback", "MissingModule"]);
    tier.known.delete(blob);
  });
});

describe("linker C without a usable dynamic tier", () => {
  let bare: Tier;
  afterAll(async () => {
    await bare?.close();
  });

  it("serves every dynamic entry point packed while the dynamic host has no manifest, then while it has no Worker Loader", async () => {
    bare = await serveTier(t, out, { loader: false, seed: false });
    const call2 = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${bare.served.url}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, json: (await r.json()) as any, tier: r.headers.get("x-forge-tier"), miss: r.headers.get("x-forge-tier-miss") };
    };
    const c = await call2("POST", "/v1/customers", { code: "BARE", name: "Bare" });
    const s = await call2("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await call2("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    expect([o.status, o.tier, o.miss]).toEqual([201, "packed-fallback", "NoManifest"]);
    const { seedKit } = await import("../src/local.ts");
    await seedKit(bare.host, join(unitsOut, "../app.json"));
    expect((await linkDynamic(bare.host, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules") })).status).toBe(200);
    const sub = await call2("POST", `/v1/orders/${o.json.id}/submit`, { expectedVersion: 1 });
    expect([sub.status, sub.json.status, sub.tier, sub.miss]).toEqual([200, "Submitted", "packed-fallback", "LoaderUnavailable"]);
    const st = await tierStats(bare.served);
    expect(st.byReason).toEqual({ NoManifest: 1, LoaderUnavailable: 1 });
  });
});

