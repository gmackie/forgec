// FORG-43: linker C's dynamic swap and fallback, demonstrated on local workerd (Miniflare), with local
// latency numbers. Run from the repository root after run.sh has linked the targets
// (examples/acme/generated/linked/{per-entry-point,tiered}):
//   node research/composable-units/r3-linker-tiered/measure.ts
// Writes results/swap.json and results/latency.json. Every timing is client wall time over loopback
// on local workerd; none is a deployed reading.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { link, type Link } from "../../../packages/linker-packed/src/index.ts";
import { scriptsOf, serve } from "../../../packages/linker-packed/src/local.ts";
import type { TieredLink } from "../../../packages/linker-tiered/src/link.ts";
import { linkDynamic, resetTierStats, tierStats } from "../../../packages/linker-tiered/src/local.ts";
import { acme, acmeManifest, breakModule, env, envPath, prepare, raiseLimit, scriptDigests, sealVariant, serveTier, unitsOut } from "../../../packages/linker-tiered/test/fixtures.ts";
import { stableJson } from "../../../packages/units/src/index.ts";

const here = import.meta.dirname;
const RUNS = Number(process.env["RUNS"] ?? 30);
const linked = join(acme, "generated/linked");
const tieredDir = join(linked, "tiered");
const SUBMIT = "POST /v1/orders/{order}/submit";

// The routers' FALLBACK log lines, as workerd prints them through Miniflare.
const logLines: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const l of text.split("\n")) if (l.includes("linker-tiered: FALLBACK")) logLines.push(l.trim());
    return (write as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stream.write;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Number(s[Math.floor((s.length - 1) / 2)]!.toFixed(2)) : null;
};
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Number(s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!.toFixed(2)) : null;
};
const summary = (xs: number[]) => ({ n: xs.length, medianMs: median(xs), p95Ms: p95(xs) });

function client(base: string, tenant: string) {
  const H = { "x-forge-tenant": tenant, "x-forge-actor": "measure", "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown) => {
    const t0 = performance.now();
    const r = await fetch(`${base}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = (await r.json()) as any;
    return { ms: performance.now() - t0, status: r.status, json, tier: r.headers.get("x-forge-tier"), miss: r.headers.get("x-forge-tier-miss"), closure: r.headers.get("x-forge-closure"), isolate: r.headers.get("x-forge-isolate") };
  };
  let n = 0;
  const draft = async (subtotal = "10.00") => {
    n++;
    const c = await call("POST", "/v1/customers", { code: `MSR${String.fromCharCode(65 + Math.floor(n / 26) % 26)}${String.fromCharCode(65 + (n % 26))}`, name: "Measure" });
    if (c.status !== 201) throw new Error(`customer: ${c.status} ${JSON.stringify(c.json)}`);
    const s = await call("POST", "/v1/sites", { customer: c.json.id, code: "hq", name: "HQ", timezone: "UTC" });
    const o = await call("POST", "/v1/orders", { customer: c.json.id, site: s.json.id, subtotal, tax: "1.00", requestedOn: "2026-09-20" });
    if (o.status !== 201) throw new Error(`order: ${o.status} ${JSON.stringify(o.json)}`);
    return { id: o.json.id as string, create: o };
  };
  // Every measured submit must be an answer from the operation, not a routing miss.
  const submit = async (id: string) => {
    const r = await call("POST", `/v1/orders/${id}/submit`, { expectedVersion: 1 });
    if (r.status !== 200 && r.status !== 409) throw new Error(`submit: ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  };
  return { call, draft, submit };
}

prepare();
const t = JSON.parse(readFileSync(join(tieredDir, "tiered.json"), "utf8")) as TieredLink;
const packedOnly = JSON.parse(readFileSync(join(linked, "per-entry-point/link.json"), "utf8")) as Link;

// ------------------------------------------------------------------------------------- latency
async function latencyTiered() {
  const tier = await serveTier(t, tieredDir);
  try {
    const c = client(tier.served.url, "lat-tiered");
    await c.call("GET", "/v1/customers");
    const first = await c.draft();
    const firstSubmit = await c.submit(first.id);
    const out = { get: [] as number[], create: [] as number[], submit: [] as number[] };
    for (let i = 0; i < RUNS; i++) {
      out.get.push((await c.call("GET", "/v1/customers")).ms);
      const d = await c.draft();
      out.create.push(d.create.ms);
      out.submit.push((await c.submit(d.id)).ms);
    }
    // Fallback: every submit's child fails to load, so each pays the dynamic host's refusal first.
    const broken = await sealVariant(breakModule);
    await linkDynamic(tier.host, { manifestText: broken.text, modulesDir: join(broken.dir, "modules"), known: tier.known });
    const fallback: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const d = await c.draft();
      const r = await c.submit(d.id);
      if (r.tier !== "packed-fallback") throw new Error(`expected a fallback, got ${r.tier}`);
      fallback.push(r.ms);
    }
    return {
      "GET /v1/customers (packed, through the tiered router)": summary(out.get),
      "POST /v1/orders (dynamic, warm)": summary(out.create),
      "POST …/submit (dynamic): first request, cold child": { ms: Number(firstSubmit.ms.toFixed(2)), tier: firstSubmit.tier, isolate: firstSubmit.isolate },
      "POST …/submit (dynamic, warm)": summary(out.submit),
      "POST …/submit (packed-fallback: LoadFailed, then the packed script)": summary(fallback),
    };
  } finally {
    await tier.close();
  }
}

async function latencyPacked() {
  const served = await serve(scriptsOf(packedOnly, join(linked, "per-entry-point")), env(), { secret: "t5-local-cursor-secret", migrations: join(acme, "migrations/d1") });
  try {
    const c = client(served.url, "lat-packed");
    await c.call("GET", "/v1/customers");
    const first = await c.draft();
    await c.submit(first.id);
    const out = { get: [] as number[], create: [] as number[], submit: [] as number[] };
    for (let i = 0; i < RUNS; i++) {
      out.get.push((await c.call("GET", "/v1/customers")).ms);
      const d = await c.draft();
      out.create.push(d.create.ms);
      out.submit.push((await c.submit(d.id)).ms);
    }
    return { "GET /v1/customers": summary(out.get), "POST /v1/orders": summary(out.create), "POST …/submit": summary(out.submit) };
  } finally {
    await served.close();
  }
}

// ------------------------------------------------------------------------------- swap, fallback
async function swapAndFallback() {
  const tier = await serveTier(t, tieredDir);
  try {
    const c = client(tier.served.url, "swap");
    const before = scriptDigests(tieredDir);
    const original = acmeManifest();
    const big = await c.draft("1500.00");
    const declined = await c.submit(big.id);

    // The edit: AuthorizePayment's limit 1000 -> 2000, re-sealed from an edited copy of impl/.
    const swapped = await sealVariant(raiseLimit);
    const changedEntryPoints = swapped.manifest.entryPoints.filter((e) => e.closureHash !== original.entryPoints.find((x) => x.id === e.id)!.closureHash).map((e) => e.id).sort();
    const dynamicIds = new Set(t.dynamic.map((d) => d.id));
    const swap = await linkDynamic(tier.host, { manifestText: swapped.text, modulesDir: join(swapped.dir, "modules"), known: tier.known });
    const after = scriptDigests(tieredDir);
    const big2 = await c.draft("1500.00");
    const authorized = await c.submit(big2.id);
    const stillPacked = await c.call("GET", "/v1/customers");

    // What linker A alone would re-upload for the same edit.
    const aOut = mkdtempSync(join(tmpdir(), "forg43-a-swap-"));
    const aSwapped = await link({ app: acme, manifestDir: join(swapped.dir), environment: envPath, strategy: "per-entry-point", out: aOut, manifest: swapped.manifest });
    const aChanged = aSwapped.scripts.filter((s) => s.scriptHash !== packedOnly.scripts.find((p) => p.name === s.name)?.scriptHash);

    // Fallback 1: a module that fails to evaluate (the child cannot start: LoadFailed).
    const broken = await sealVariant(breakModule);
    const brokenLink = await linkDynamic(tier.host, { manifestText: broken.text, modulesDir: join(broken.dir, "modules"), known: tier.known });
    await resetTierStats(tier.served);
    const small = await c.draft();
    const fb1 = await c.submit(small.id);
    const big3 = await c.draft("1500.00");
    const fb2 = await c.submit(big3.id);
    const statsLoadFailed = await tierStats(tier.served);

    // Fallback 2: a module blob gone from the unit store after the host's code cache is evicted (MissingModule).
    await linkDynamic(tier.host, { manifestText: swapped.text, modulesDir: join(swapped.dir, "modules"), known: tier.known });
    const swappedBlob = Object.keys(swapped.manifest.modules).find((b) => !original.modules[b])!;
    await (await tier.served.mf.getR2Bucket("UNITS", t.host.name)).delete(`blobs/${swappedBlob.slice("sha256:".length)}`);
    await tier.host.fetch("/_linker/evict-host-cache", { method: "POST" });
    const big4 = await c.draft("1500.00");
    const fb3 = await c.submit(big4.id);

    // Recovery: link the sealed manifest again; the dynamic tier serves.
    const restored = await linkDynamic(tier.host, { manifestText: readFileSync(join(unitsOut, "manifest.json"), "utf8"), modulesDir: join(unitsOut, "modules"), known: tier.known });
    const small2 = await c.draft();
    const back = await c.submit(small2.id);
    const finalStats = await tierStats(tier.served);
    const pick = (r: Awaited<ReturnType<typeof c.call>>) => ({ status: r.status, tier: r.tier, miss: r.miss, closure: r.closure, result: r.json.status ?? r.json.code });

    return {
      edit: "impl/payment-adapter.ts: AuthorizePayment's limit `amount >= 1000` -> `amount >= 2000`, re-sealed with the unchanged unit plan",
      manifests: { before: original.manifestHash, after: swapped.manifest.manifestHash },
      closuresChanged: changedEntryPoints.map((id) => ({ id, tier: dynamicIds.has(id) ? "dynamic" : "packed" })),
      dynamicTier: {
        uploaded: swap.uploaded,
        manifestPut: { status: swap.status, previous: swap.body["previous"], manifestHash: swap.body["manifestHash"] },
        ms: Number(swap.ms.toFixed(2)),
      },
      scripts: {
        count: Object.keys(before).length,
        changed: Object.keys(before).filter((k) => before[k] !== after[k]),
        uploaded: 0,
        note: "sha256 of every worker.js in the tiered link, before and after the swap: the router, the tier host and all 87 packed scripts",
      },
      linkerAAlone: { scriptsReuploaded: aChanged.map((s) => s.name).sort(), bytes: aChanged.reduce((n, s) => n + (s.bytes?.raw ?? 0), 0) },
      behaviour: { beforeSwap: pick(declined), afterSwap: pick(authorized), packedRouteAfterSwap: pick(stillPacked), newSubmitClosure: swapped.manifest.entryPoints.find((e) => e.id === SUBMIT)!.closureHash },
      fallback: {
        loadFailed: { manifestPut: brokenLink.status, smallOrder: pick(fb1), bigOrder: pick(fb2), routerStats: { fallback: statsLoadFailed.fallback, byReason: statsLoadFailed.byReason, byEntryPoint: statsLoadFailed.byEntryPoint } },
        missingModule: { bigOrder: pick(fb3) },
        recovered: { manifestPut: restored.status, smallOrder: pick(back) },
        routerStatsAtEnd: { dynamic: finalStats.dynamic, packed: finalStats.packed, fallback: finalStats.fallback, errors: finalStats.errors, byReason: finalStats.byReason },
        logLines: [...new Set(logLines)],
      },
    };
  } finally {
    await tier.close();
  }
}

const swap = await swapAndFallback();
writeFileSync(join(here, "results/swap.json"), stableJson({ version: "r3-swap/1", issue: "FORG-43", local: true, date: new Date().toISOString().slice(0, 10), node: process.version, ...swap }));
console.log("swap:", JSON.stringify({ scriptsChanged: swap.scripts.changed, uploaded: swap.dynamicTier.uploaded.length, linkerA: swap.linkerAAlone.scriptsReuploaded.length }));
const latency = { tiered: await latencyTiered(), packed: await latencyPacked() };
writeFileSync(join(here, "results/latency.json"), stableJson({ version: "r3-latency/1", issue: "FORG-43", local: true, note: "local workerd via Miniflare, client wall time over loopback; not a deployed reading", runs: RUNS, date: new Date().toISOString().slice(0, 10), node: process.version, ...latency }));
console.log(JSON.stringify(latency, null, 2));
