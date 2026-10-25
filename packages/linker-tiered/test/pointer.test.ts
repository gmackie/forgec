// FORG-47: the shared manifest pointer across several host isolates, on local workerd (Miniflare).
// Deployed, several isolates of one host serve at once, and before FORG-47 a swap reached only the one
// that took the PUT (research/composable-units/r4-deployed). Locally each Miniflare worker is its own
// isolate, so a host is run as several workers (`<host>-r<i>`) from the same bundle, sharing one
// pointer Durable Object, one unit store and one D1, as deployed isolates do.
//
//   - linker B: 3 host isolates; a swap and a swap-back reach every one within the bound; a stale CAS is
//     refused; a 4th isolate whose pointer DO is unreachable refuses (LinkerRefused/PointerUnavailable).
//   - linker C: 3 router -> tier-host pairs; the FORG-38 sequence (swap, break, restore) with no fallback
//     after the restore once the bound has passed; the pair whose pointer DO is unreachable falls back
//     packed, counted in the shared stats with a real `since`.
//
// POINTER_RESULTS=<dir> writes <dir>/local.json (research/composable-units/r4-manifest-pointer).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TieredLink } from "../src/link.ts";
import { ADMIN_TOKEN, dynamicHostScripts, hostFetcher, linkDynamic, replicaName, resetTierStats, seedKit, serve, tierStats, type Served } from "../src/local.ts";
import { acme, acmeManifest, acmeManifestText, breakModule, env, linkAcme, prepare, raiseLimit, sealVariant, serveTier, unitsOut, type Tier } from "./fixtures.ts";

const TTL = 500;
const FLUSH = 200;
const SUBMIT = "POST /v1/orders/{order}/submit";
const results: Record<string, unknown> = { version: "r4-manifest-pointer-local/1", issue: "FORG-47", measured: true, local: true, date: new Date().toISOString(), node: process.version, ttlMs: TTL, statsFlushMs: FLUSH };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);

let swapped: Awaited<ReturnType<typeof sealVariant>>;
let broken: Awaited<ReturnType<typeof sealVariant>>;
beforeAll(async () => {
  prepare();
  swapped = await sealVariant(raiseLimit);
  broken = await sealVariant(breakModule);
}, 600_000);
afterAll(() => {
  const dir = process.env["POINTER_RESULTS"];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "local.json"), `${JSON.stringify(results, null, 2)}\n`);
});

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;
const tenant = `p-${Math.random().toString(36).slice(2, 8)}`;
const H = { "x-forge-tenant": tenant, "x-forge-actor": "tester", "content-type": "application/json" };

/** An app client over one instance (`f` reaches exactly that worker). */
function client(f: Fetch) {
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await f(path, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    const ptr = r.headers.get("x-forge-pointer");
    return { status: r.status, json, pointer: ptr, version: ptr ? Number(/v=(\d+)/.exec(ptr)![1]) : null, pointerMs: Number(r.headers.get("x-forge-pointer-ms") ?? NaN), closure: r.headers.get("x-forge-closure"), tier: r.headers.get("x-forge-tier"), miss: r.headers.get("x-forge-tier-miss"), refused: r.headers.get("x-forge-linker-refused"), reason: r.headers.get("x-forge-linker-refused-reason") };
  };
  const draftOrder = async (code: string, subtotal = "10.00") => {
    const c = await call("POST", "/v1/customers", { code, name: "Pointer" });
    const s = await call("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await call("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal, tax: "1.00", requestedOn: "2026-09-20" });
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    return o.json.id as string;
  };
  return { call, draftOrder };
}

const workerFetch = async (served: Served, name: string): Promise<Fetch> => {
  const w = (await served.mf.getWorker(name)) as unknown as { fetch(u: string, i?: RequestInit): Promise<Response> };
  return (path, init) => w.fetch(`http://local${path}`, init);
};

/**
 * Polls `probe` on every instance until each reports `version`; returns, per instance, ms from the
 * swap's answer to the first request that saw it. A request must see it once it starts TTL after the swap.
 */
async function visibility(swappedAt: number, instances: Array<() => Promise<number | null>>, version: number): Promise<number[]> {
  return Promise.all(
    instances.map(async (probe) => {
      for (;;) {
        const started = performance.now();
        const v = await probe();
        if (v === version) return Math.round(started - swappedAt);
        // Bound: a request that started TTL after the swap must already see it.
        expect(started - swappedAt, `still version ${v} after the bound`).toBeLessThan(TTL);
        await sleep(25);
      }
    }),
  );
}

describe("linker B: one pointer, several host isolates", () => {
  let served: Served;
  const N = 3;
  let hosts: Array<ReturnType<typeof client>>;
  let admins: Array<Awaited<ReturnType<typeof hostFetcher>>>;
  const out = mkdtempSync(join(tmpdir(), "forg47-b-"));

  beforeAll(async () => {
    served = await serve(await dynamicHostScripts(join(out, "host"), env(), { replicas: N + 1, pointerDown: [N], pointerTtlMs: TTL }), env(), { secret: "t5-local-cursor-secret", migrations: join(acme, "migrations/d1") });
    admins = await Promise.all([...Array(N + 1).keys()].map((i) => hostFetcher(served, replicaName("forge-acme-linker-dynamic", i))));
    hosts = await Promise.all([...Array(N + 1).keys()].map(async (i) => client(await workerFetch(served, replicaName("forge-acme-linker-dynamic", i)))));
    await seedKit(admins[0]!, join(acme, "generated/app.json"));
    const r = await linkDynamic(admins[0]!, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules"), ifMatch: 0 });
    expect([r.status, r.body["version"]]).toEqual([200, 1]);
  }, 600_000);
  afterAll(async () => {
    await served?.close();
  });

  it("every isolate serves the linked manifest, read from the pointer (not from the PUT)", async () => {
    const reads: Record<string, number[]> = { changed: [], revalidated: [], cached: [] };
    for (let i = 0; i < N; i++) {
      const r = await hosts[i]!.call("GET", "/v1/customers");
      expect([r.status, r.version], `host ${i}`).toEqual([200, 1]);
      // Only instance 0 took the PUT; the others found the manifest through the DO.
      expect(r.pointer!.split(";")[0], `host ${i}`).toBe(i === 0 ? "cached" : "changed");
    }
    // Pointer read cost: a cache hit, and a revalidation (a DO read) once the copy is older than the bound.
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < N; i++) {
        const r = await hosts[i]!.call("GET", "/v1/customers");
        reads[r.pointer!.split(";")[0]!]!.push(r.pointerMs);
      }
      await sleep(round % 2 ? TTL + 20 : 10);
    }
    expect(reads["revalidated"]!.length).toBeGreaterThan(0);
    expect(reads["cached"]!.length).toBeGreaterThan(0);
    results["b.pointerRead"] = { cachedMs: { n: reads["cached"]!.length, median: median(reads["cached"]!) }, revalidatedMs: { n: reads["revalidated"]!.length, median: median(reads["revalidated"]!), max: Math.max(...reads["revalidated"]!) }, note: "x-forge-pointer-ms: wall time of the DO read inside the host (0 on a cache hit)" };
  });

  it("a swap and a swap-back reach every isolate within the bound", async () => {
    const declined = await Promise.all(hosts.slice(0, N).map((h, i) => h.draftOrder(`BIG${i}`, "1500.00")));
    for (let i = 0; i < N; i++) {
      const r = await hosts[i]!.call("POST", `/v1/orders/${declined[i]}/submit`, { expectedVersion: 1 });
      expect(r.json.code, `host ${i}`).toBe("@acme/commerce/_/SubmitOrder.PaymentDeclined");
    }
    // Swap on instance 0 (AuthorizePayment's limit 1000 -> 2000), naming version 1.
    const sw = await linkDynamic(admins[0]!, { manifestText: swapped.text, modulesDir: join(swapped.dir, "modules"), ifMatch: 1 });
    const at = performance.now();
    expect([sw.status, sw.body["version"], sw.body["previous"]]).toEqual([200, 2, acmeManifest().manifestHash]);
    const swapMs = await visibility(at, hosts.slice(0, N).map((h) => async () => (await h.call("GET", "/v1/customers")).version), 2);
    // ...and with it the new closure: a 1500.00 order is authorized on every isolate.
    const big = await Promise.all(hosts.slice(0, N).map((h, i) => h.draftOrder(`NEW${i}`, "1500.00")));
    for (let i = 0; i < N; i++) {
      const r = await hosts[i]!.call("POST", `/v1/orders/${big[i]}/submit`, { expectedVersion: 1 });
      expect([r.status, r.json.status, r.closure], `host ${i}`).toEqual([200, "Submitted", swapped.manifest.entryPoints.find((e) => e.id === SUBMIT)!.closureHash]);
    }
    // Swap back from instance 1, naming version 2.
    const back = await linkDynamic(admins[1]!, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules"), ifMatch: 2 });
    const at2 = performance.now();
    expect([back.status, back.body["version"]]).toEqual([200, 3]);
    const backMs = await visibility(at2, hosts.slice(0, N).map((h) => async () => (await h.call("GET", "/v1/customers")).version), 3);
    const again = await Promise.all(hosts.slice(0, N).map((h, i) => h.draftOrder(`OLD${i}`, "1500.00")));
    for (let i = 0; i < N; i++) {
      const r = await hosts[i]!.call("POST", `/v1/orders/${again[i]}/submit`, { expectedVersion: 1 });
      expect([r.json.code, r.closure], `host ${i}`).toEqual(["@acme/commerce/_/SubmitOrder.PaymentDeclined", acmeManifest().entryPoints.find((e) => e.id === SUBMIT)!.closureHash]);
    }
    results["b.visibility"] = { isolates: N, swapMs, swapBackMs: backMs, boundMs: TTL, note: "ms from the PUT's answer to the first request on each isolate that served the new version (polled every ~25 ms); the writer's own isolate sees it at once" };
  });

  it("refuses a stale compare-and-swap and leaves the pointer where it was", async () => {
    const stale = await linkDynamic(admins[2]!, { manifestText: swapped.text, modulesDir: join(swapped.dir, "modules"), ifMatch: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "StalePointer", expected: 1, current: 3, manifestHash: acmeManifest().manifestHash });
    const p = (await (await admins[2]!.fetch("/_linker/pointer")).json()) as { pointer: { version: number; manifestHash: string } };
    expect([p.pointer.version, p.pointer.manifestHash]).toEqual([3, acmeManifest().manifestHash]);
    results["b.staleCas"] = { status: stale.status, body: stale.body };
  });

  it("an isolate that cannot reach the pointer's Durable Object refuses: LinkerRefused/PointerUnavailable", async () => {
    const r = await hosts[N]!.call("GET", "/v1/customers");
    expect([r.status, r.json.code, r.json.reason, r.refused, r.reason]).toEqual([503, "LinkerRefused", "PointerUnavailable", "LinkerRefused", "PointerUnavailable"]);
    const put = await linkDynamic(admins[N]!, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules") });
    expect([put.status, put.body["code"]]).toEqual([503, "LinkerRefused"]);
    // ...and the healthy isolates are unaffected.
    expect((await hosts[0]!.call("GET", "/v1/customers")).status).toBe(200);
    results["b.pointerDown"] = { request: { status: r.status, code: r.json.code, reason: r.json.reason }, swap: { status: put.status, code: put.body["code"] } };
  });
});

describe("linker C: one pointer and one set of stats, several router and tier-host isolates", () => {
  let tier: Tier;
  let t: TieredLink;
  const N = 3;
  let routers: Array<ReturnType<typeof client>>;
  let admins: Array<Awaited<ReturnType<typeof hostFetcher>>>;
  const out = mkdtempSync(join(tmpdir(), "forg47-c-"));

  beforeAll(async () => {
    t = await linkAcme(out);
    // Instance N-1's tier host cannot reach the pointer.
    tier = await serveTier(t, out, { replicas: N, pointerDown: [N - 1], pointerTtlMs: TTL, statsFlushMs: FLUSH });
    routers = await Promise.all([...Array(N).keys()].map(async (i) => client(await workerFetch(tier.served, replicaName(t.router.name, i)))));
    admins = await Promise.all([...Array(N).keys()].map((i) => hostFetcher(tier.served, replicaName(t.host.name, i))));
    await resetTierStats(tier.served);
  }, 600_000);
  afterAll(async () => {
    await tier?.close();
  });

  const submitBig = async (i: number, code: string) => {
    const r = routers[i]!;
    const id = await r.draftOrder(code, "1500.00");
    return r.call("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
  };
  const healthy = () => routers.slice(0, N - 1);

  it("the pointer records the tier's dynamic closures", async () => {
    const p = (await (await admins[0]!.fetch("/_linker/pointer")).json()) as { pointer: { version: number; dynamic: Record<string, string> } };
    expect(p.pointer.version).toBe(1);
    expect(Object.keys(p.pointer.dynamic).sort()).toEqual([...t.dynamic.map((d) => d.id)].sort());
  });

  it("FORG-38's sequence: swap, break, restore; after the restore no isolate falls back once the bound has passed", async () => {
    for (let i = 0; i < N - 1; i++) expect((await submitBig(i, `C0${i}`)).json.code, `router ${i}`).toBe("@acme/commerce/_/SubmitOrder.PaymentDeclined");
    // POST /v1/customers is packed: probe the dynamic tier through a dynamic route (POST /v1/orders).
    const dynProbe = (i: number) => async () => {
      const r = routers[i]!;
      const c = await r.call("POST", "/v1/customers", { code: `D${Math.random().toString(36).slice(2, 7)}`, name: "probe" });
      const s = await r.call("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
      const o = await r.call("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" });
      expect(o.tier).toBe("dynamic");
      return o.version;
    };
    // 1. Swap (limit 2000) through tier host 0.
    const sw = await linkDynamic(admins[0]!, { manifestText: swapped.text, modulesDir: join(swapped.dir, "modules"), known: tier.known, ifMatch: 1 });
    const at = performance.now();
    expect(sw.status).toBe(200);
    const swapMs = await visibility(at, [dynProbe(0), dynProbe(1)], 2);
    for (let i = 0; i < N - 1; i++) {
      const r = await submitBig(i, `C1${i}`);
      expect([r.status, r.tier, r.json.status], `router ${i}`).toEqual([200, "dynamic", "Submitted"]);
    }
    // 2. Break it (AuthorizePayment throws while evaluated) through tier host 1: every isolate falls back.
    const br = await linkDynamic(admins[1]!, { manifestText: broken.text, modulesDir: join(broken.dir, "modules"), known: tier.known, ifMatch: 2 });
    expect(br.status).toBe(200);
    await sleep(TTL + 50);
    for (let i = 0; i < N - 1; i++) {
      const r = await submitBig(i, `C2${i}`);
      expect([r.tier, r.miss], `router ${i}`).toEqual(["packed-fallback", "LoadFailed"]);
    }
    // 3. Restore the sealed manifest through tier host 0. In FORG-38 one later submit still fell back.
    const ok = await linkDynamic(admins[0]!, { manifestText: acmeManifestText(), modulesDir: join(unitsOut, "modules"), known: tier.known, ifMatch: 3 });
    const at3 = performance.now();
    expect(ok.status).toBe(200);
    const restoreMs = await visibility(at3, [dynProbe(0), dynProbe(1)], 4);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < N - 1; i++) {
        const r = await submitBig(i, `C3${round}${i}`);
        expect([r.tier, r.miss, r.json.code], `router ${i}, round ${round}`).toEqual(["dynamic", null, "@acme/commerce/_/SubmitOrder.PaymentDeclined"]);
      }
    }
    results["c.visibility"] = { isolates: N - 1, swapMs, restoreMs, boundMs: TTL };
  });

  it("a tier host that cannot reach the pointer is a counted fallback, never a hidden one", async () => {
    // Both dynamic requests (the order create and the submit) fall back; the packed script holds the
    // implementation it was linked with (limit 1000), so the 1500.00 order is declined there.
    const r = await submitBig(N - 1, "CDN1");
    expect([r.status, r.tier, r.miss, r.json.code]).toEqual([409, "packed-fallback", "LinkerRefused/PointerUnavailable", "@acme/commerce/_/SubmitOrder.PaymentDeclined"]);
    // Packed reads on that router are unaffected.
    expect((await routers[N - 1]!.call("GET", "/v1/customers")).tier).toBe("packed");
  });

  it("the stats are shared across router isolates, with a real since", async () => {
    await sleep(FLUSH + 300);
    const st = (await tierStats(tier.served)) as Awaited<ReturnType<typeof tierStats>> & { scope: string; since: string; isolates: Record<string, { kind: string }> };
    expect(st.scope).toBe("shared");
    expect(Date.parse(st.since)).toBeGreaterThan(Date.parse("2026-01-01"));
    // Read through router 0; the fallbacks were served by routers 0, 1 (LoadFailed) and 2 (PointerUnavailable, twice).
    expect(st.byReason).toEqual({ LoadFailed: 2, "LinkerRefused/PointerUnavailable": 2 });
    expect(st.fallback).toBe(4);
    expect(st.dynamic).toBeGreaterThan(0);
    expect(Object.values(st.isolates).filter((x) => x.kind === "router").length).toBe(N);
    // And the same answer from any router.
    const other = (await (await (await workerFetch(tier.served, replicaName(t.router.name, 1)))("/_forge/tiered/stats", { headers: { "x-forge-tier-token": "local-tier-stats" } })).json()) as { fallback: number };
    expect(other.fallback).toBe(4);
    results["c.stats"] = { scope: st.scope, since: st.since, dynamic: st.dynamic, packed: st.packed, fallback: st.fallback, byReason: st.byReason, routerIsolates: Object.values(st.isolates).filter((x) => x.kind === "router").length };
  });

  it("admin requests need the token", async () => {
    const w = await workerFetch(tier.served, t.host.name);
    expect((await w("/_linker/pointer")).status).toBe(403);
    expect(ADMIN_TOKEN).toBeTruthy();
  });
});
