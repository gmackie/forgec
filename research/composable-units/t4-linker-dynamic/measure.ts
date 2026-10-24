// FORG-30 measurements for Linker B on examples/acme, all on local workerd (wrangler dev --local).
// Run from the repository root after `cargo build -p forgegraph-cli` and `pnpm install`:
//   node research/composable-units/t4-linker-dynamic/measure.ts
// Writes results.json and conformance/*.json next to this file. Nothing here is estimated; anything
// this script cannot measure is listed under `missing`.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { stableJson } from "../../../packages/units/src/index.ts";
import { childMain, childSource, type LinkerKit } from "../../../packages/linker-dynamic/src/child.ts";
import type { ClosureManifest } from "../../../packages/linker-dynamic/src/manifest.ts";
import { derivePolicy, type SqlSchema } from "../../../packages/linker-dynamic/src/policy.ts";
// @ts-expect-error untyped harness module
import * as harness from "../../../packages/linker-dynamic/scripts/harness.mjs";

const h = harness as any;
const here = import.meta.dirname;
const RUNS = Number(process.env["RUNS"] ?? 30);
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 100) / 100 : null;
};
const summary = (xs: number[]) => ({ n: xs.length, min: quantile(xs, 0), median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1) });
const round = (x: number) => Math.round(x * 100) / 100;

h.prepare({ force: true });
const manifest = JSON.parse(readFileSync(join(h.unitsOut, "manifest.json"), "utf8")) as ClosureManifest;
const app = JSON.parse(readFileSync(join(h.acme, "generated/app.json"), "utf8")) as { buildHash: string; sql: SqlSchema };
const libs = JSON.parse(readFileSync(join(h.pkg, "generated/libs/libs.json"), "utf8")) as Record<string, { digest: string; file: string; bytes: number }>;

// ------------------------------------------------------------------------------- static sizes
const kit: LinkerKit = { libraries: Object.fromEntries(Object.entries(libs).map(([k, v]) => [k, v.digest])), apps: { [app.buildHash]: "sha256:app" } };
const fileBytes = (name: string) => (name === "app.json" ? readFileSync(join(h.acme, "generated/app.json")) : readFileSync(join(h.unitsOut, "modules", name.slice(2))));
const libFile = (name: string, version: string) => readFileSync(join(h.pkg, "generated/libs", libs[`${name}@${version}`]!.file));
const perChild = new Map<string, { entries: string[]; bytes: number; gzip: number; units: number; main: number }>();
for (const e of manifest.entryPoints) {
  if (e.kind === "durable-object") continue;
  const p = derivePolicy(manifest, e, app.sql);
  const src = childSource(manifest, p, kit);
  const main = childMain(src, p, ["CURSOR_SECRET", "FORGE_AUTH"]);
  const parts: Buffer[] = [Buffer.from(main)];
  for (const name of Object.keys(src.blobs)) parts.push(name === "app.json" || name.startsWith("u-") ? fileBytes(name) : libFile(name, src.libraries[name]!));
  const all = Buffer.concat(parts);
  const key = `${e.closureHash}|${p.label.startsWith("runtime") ? "runtime" : JSON.stringify(p.tables) + p.queues + p.objects + p.workflows}`;
  const prev = perChild.get(key);
  if (prev) prev.entries.push(e.id);
  else perChild.set(key, { entries: [e.id], bytes: all.byteLength, gzip: gzipSync(all, { level: 9 }).byteLength, units: src.units.length, main: Buffer.byteLength(main) });
}
const childBytes = [...perChild.values()].map((c) => c.bytes);

// --------------------------------------------------------------------------- a swap variant
// FulfillOrder's body changes (it now also reads the order's revision); only the closures
// containing it get new closure hashes. Edits esbuild drops (comments, unused exports) leave the
// module bytes, and so every hash, unchanged.
const swapped = await h.sealVariant((impl: string) => {
  const ff = join(impl, "fulfill-order.ts");
  writeFileSync(ff, readFileSync(ff, "utf8").replace("return order;", "return { ...order, observedRevision: msg.revision };"));
});
const variantDir = swapped.dir as string;
const variant = swapped.manifest as ClosureManifest;
if (Object.keys(variant.modules).filter((b) => !manifest.modules[b]).length !== 1) throw new Error("the swap edit must change exactly one module");
const changedEntries = variant.entryPoints.filter((e) => e.closureHash !== manifest.entryPoints.find((x) => x.id === e.id)!.closureHash).map((e) => e.id).sort();

// -------------------------------------------------------------------------------- requests
const tenant = `m-${Date.now().toString(36)}`;
const H = { "x-forge-tenant": tenant, "x-forge-actor": "measure", "content-type": "application/json" };
async function timed(base: string, method: string, path: string, body?: unknown) {
  const t0 = performance.now();
  const r = await fetch(`${base}${path}`, { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  const wall = performance.now() - t0;
  return { status: r.status, wall, link: Number(r.headers.get("x-forge-link-ms") ?? NaN), isolate: r.headers.get("x-forge-isolate"), closure: r.headers.get("x-forge-closure"), json: (() => { try { return JSON.parse(text); } catch { return text; } })() };
}
const GET_ROUTES = ["/v1/customers", "/v1/sites", "/v1/orders", "/v1/departments", "/v1/site-policies", "/v1/order-documents"];

async function runConformance(base: string, name: string) {
  const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
    const p = spawn("pnpm", ["vitest", "run", "test/remote.test.ts"], { cwd: join(h.root, "conformance"), env: { ...process.env, FORGE_TARGET_URL: base, FORGE_TARGET_NAME: name } });
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stdout += d));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
  const report = JSON.parse(readFileSync(join(h.root, "conformance/reports", `${name}.json`), "utf8")) as { scenarios: Array<{ id: string; steps: number; failures: Array<{ step: string; actual: any }> }> };
  const scenarios = report.scenarios.map((s) => {
    const codes: Record<string, number> = {};
    for (const f of s.failures) {
      const c = typeof f.actual === "object" && f.actual ? String(f.actual.code ?? "value") : "value";
      codes[c] = (codes[c] ?? 0) + 1;
    }
    return { id: s.id, steps: s.steps, failures: s.failures.length, failureCodes: codes, passed: s.failures.length === 0 };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  mkdirSync(join(here, "conformance"), { recursive: true });
  writeFileSync(join(here, "conformance", `${name}.json`), stableJson({ target: name, exitCode: out.code, scenarios }));
  return { passed: scenarios.filter((s) => s.passed).length, total: scenarios.length, steps: scenarios.reduce((n, s) => n + s.steps, 0), failedScenarios: scenarios.filter((s) => !s.passed).map((s) => ({ id: s.id, failures: s.failures, failureCodes: s.failureCodes })) };
}

const results: Record<string, any> = { version: "t4-linker-dynamic-results/1", issue: "FORG-30", local: true };

// ---- host: cold, warm, swap
{
  const host = await h.startWorker({ kind: "host", port: 8961 });
  try {
    await h.seedKit(host.base);
    const tLink = performance.now();
    const linked = await h.linkManifest(host.base, { modulesDir: join(h.unitsOut, "modules") });
    const linkMs = performance.now() - tLink;
    if (linked.status !== 200) throw new Error(`link failed: ${JSON.stringify(linked.body)}`);

    const cold: any[] = [];
    for (const path of GET_ROUTES) cold.push({ path, ...(await timed(host.base, "GET", path)) });
    const warm: Record<string, { wall: number[]; link: number[] }> = {};
    for (const path of GET_ROUTES.slice(0, 3)) {
      warm[path] = { wall: [], link: [] };
      for (let i = 0; i < RUNS; i++) {
        const r = await timed(host.base, "GET", path);
        if (r.isolate !== "warm") throw new Error(`${path} was not warm`);
        warm[path]!.wall.push(r.wall);
        warm[path]!.link.push(r.link);
      }
    }
    // A mutating closure with js units: SubmitOrder (2 js units), cold then warm.
    const c = (await timed(host.base, "POST", "/v1/customers", { code: "MEAS", name: "M" })).json;
    const s = (await timed(host.base, "POST", "/v1/sites", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" })).json;
    const submit: any[] = [];
    for (let i = 0; i < Math.min(RUNS, 10) + 1; i++) {
      const o = (await timed(host.base, "POST", "/v1/orders", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" })).json;
      submit.push(await timed(host.base, "POST", `/v1/orders/${o.id}/submit`, { expectedVersion: 1 }));
    }
    const st = await h.stats(host.base);

    // Swap: upload the one changed module, link the variant, then touch every previously warm closure.
    const touched = ["/v1/customers", "/v1/sites", "/v1/orders"];
    for (const p of touched) await timed(host.base, "GET", p);
    const changedBlob = Object.keys(variant.modules).find((b) => !manifest.modules[b])!;
    const tUpload = performance.now();
    await harness.putBlob(host.base, readFileSync(join(variantDir, variant.modules[changedBlob]!.path)));
    const uploadMs = performance.now() - tUpload;
    const tSwap = performance.now();
    const swappedLink = await h.linkManifest(host.base, { manifestText: stableJson(variant), modulesDir: null });
    const swapLinkMs = performance.now() - tSwap;
    if (swappedLink.status !== 200) throw new Error(`swap link failed: ${JSON.stringify(swappedLink.body)}`);
    const afterSwap: any[] = [];
    for (const p of touched) afterSwap.push({ path: p, ...(await timed(host.base, "GET", p)) });
    const afterSwapSubmit: any[] = [];
    {
      const o = (await timed(host.base, "POST", "/v1/orders", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" })).json;
      afterSwapSubmit.push(await timed(host.base, "POST", `/v1/orders/${o.id}/submit`, { expectedVersion: 1 }));
    }
    // The changed closure (the fulfill-order queue consumer) runs only from the queue: count its cold load via stats.
    await new Promise((r) => setTimeout(r, 3000));
    const st2 = await h.stats(host.base);
    const consumer = st2.closures.filter((x: any) => x.label.startsWith("queue-consumer:"));

    results.host = {
      linkAcmeManifestMs: round(linkMs),
      coldFirstRequest: cold.map((r) => ({ path: r.path, status: r.status, isolate: r.isolate, clientWallMs: round(r.wall), hostLinkMs: r.link })),
      coldClientWallMs: summary(cold.map((r) => r.wall)),
      coldHostLinkMs: summary(cold.map((r) => r.link)),
      hostCodeBuildMs: summary(st.closures.flatMap((x: any) => x.buildMs)),
      warm: Object.fromEntries(Object.entries(warm).map(([p, v]) => [p, { clientWallMs: summary(v.wall), hostLinkMs: summary(v.link) }])),
      submitOrder: {
        cold: { isolate: submit[0].isolate, status: submit[0].status, clientWallMs: round(submit[0].wall), hostLinkMs: submit[0].link },
        warm: { isolates: [...new Set(submit.slice(1).map((r) => r.isolate))], clientWallMs: summary(submit.slice(1).map((r) => r.wall)), hostLinkMs: summary(submit.slice(1).map((r) => r.link)) },
      },
      swap: {
        edit: "impl/fulfill-order.ts body: returns { ...order, observedRevision }",
        entryPointsWithNewClosureHash: changedEntries,
        unchangedEntryPoints: variant.entryPoints.length - changedEntries.length,
        uploadChangedModuleMs: round(uploadMs),
        linkNewManifestMs: round(swapLinkMs),
        untouchedClosuresAfterSwap: afterSwap.map((r) => ({ path: r.path, isolate: r.isolate, clientWallMs: round(r.wall) })),
        submitAfterSwap: afterSwapSubmit.map((r) => ({ isolate: r.isolate, clientWallMs: round(r.wall), status: r.status })),
        changedQueueConsumerChildren: consumer.map((x: any) => ({ closureHash: x.closureHash, cold: x.cold, warm: x.warm, buildMs: x.buildMs })),
      },
      isolates: { distinctChildrenLoaded: st2.closures.length, denials: st2.denials.length },
    };
  } finally {
    await host.stop();
  }
}

// ---- whole-app baseline (same routes, same machine)
{
  const w = await h.startWorker({ kind: "whole-app", port: 8962 });
  try {
    const first: any[] = [];
    for (const path of GET_ROUTES) first.push({ path, ...(await timed(w.base, "GET", path)) });
    const warm: Record<string, number[]> = {};
    for (const path of GET_ROUTES.slice(0, 3)) {
      warm[path] = [];
      for (let i = 0; i < RUNS; i++) warm[path]!.push((await timed(w.base, "GET", path)).wall);
    }
    const c = (await timed(w.base, "POST", "/v1/customers", { code: "MEAS", name: "M" })).json;
    const s = (await timed(w.base, "POST", "/v1/sites", { customer: c.id, code: "hq", name: "HQ", timezone: "UTC" })).json;
    const submit: number[] = [];
    for (let i = 0; i < Math.min(RUNS, 10) + 1; i++) {
      const o = (await timed(w.base, "POST", "/v1/orders", { customer: c.id, site: s.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" })).json;
      submit.push((await timed(w.base, "POST", `/v1/orders/${o.id}/submit`, { expectedVersion: 1 })).wall);
    }
    results.wholeApp = {
      firstRequestPerRoute: first.map((r) => ({ path: r.path, status: r.status, clientWallMs: round(r.wall) })),
      warm: Object.fromEntries(Object.entries(warm).map(([p, v]) => [p, { clientWallMs: summary(v) }])),
      submitOrder: { first: round(submit[0]!), warm: summary(submit.slice(1)) },
    };
  } finally {
    await w.stop();
  }
}

// ---- conformance differential
const conformance: Record<string, unknown> = {};
for (const [name, kind, vars] of [
  ["whole-app-local", "whole-app", {}],
  ["linker-dynamic-strict", "host", {}],
  ["linker-dynamic-fallback", "host", { LINKER_UNCOVERED: "runtime" }],
] as const) {
  const w = await h.startWorker({ kind, port: 8963, vars });
  try {
    if (kind === "host") {
      await h.seedKit(w.base);
      await h.linkManifest(w.base);
    }
    conformance[name] = await runConformance(w.base, name);
    if (kind === "host") {
      const st = await h.stats(w.base);
      (conformance[name] as any).linker = {
        distinctChildren: st.closures.length,
        coldLoads: st.closures.reduce((n: number, x: any) => n + x.cold, 0),
        warmRequests: st.closures.reduce((n: number, x: any) => n + x.warm, 0),
        denials: st.denials.length,
        fallbacks: st.fallbacks.length,
        refusedUnknownEntryPoints: [...new Set(st.refused.filter((x: string) => x.startsWith("UnknownEntryPoint")).map((x: string) => x.replace(/^UnknownEntryPoint: (\S+) (\S+?)(\/[^ ]*)? is not.*$/, "$1 $2$3").replace(/\/(cus|sit|ord|dep|spo|odc|chg|imp)_[0-9a-z]+/g, "/{id}").replace(/\/%24[^/]+/g, "/{id}")))].sort(),
        kindsServed: [...new Set(st.closures.map((x: any) => x.label.split(":")[0]))].sort(),
      };
    }
  } finally {
    await w.stop();
  }
}
results.conformance = conformance;

const wranglerPkg = JSON.parse(readFileSync(join(h.pkg, "node_modules/wrangler/package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
results.environment = {
  date: new Date().toISOString().slice(0, 10),
  machine: `${cpus()[0]?.model} (${platform()} ${release()})`,
  node: process.version,
  wrangler: wranglerPkg.version,
  workerd: wranglerPkg.dependencies["workerd"],
  miniflare: wranglerPkg.dependencies["miniflare"],
  hostCompatibilityDate: "2026-09-25",
  childCompatibilityDate: "2026-09-25",
  wholeAppCompatibilityDate: "2026-09-01",
  runs: RUNS,
  manifestHash: manifest.manifestHash,
  note: "Every timing is local workerd under wrangler dev on one machine. performance.now() advances during execution locally; deployed Workers advance it only across I/O, so hostLinkMs cannot be read the same way there.",
};
results.sizes = {
  libraries: Object.fromEntries(Object.entries(libs).map(([k, v]) => [k, { bytes: v.bytes, gzip: gzipSync(readFileSync(join(h.pkg, "generated/libs", v.file)), { level: 9 }).byteLength, digest: v.digest }])),
  appJson: { bytes: readFileSync(join(h.acme, "generated/app.json")).byteLength, gzip: gzipSync(readFileSync(join(h.acme, "generated/app.json")), { level: 9 }).byteLength },
  childCode: { distinctChildren: perChild.size, bytes: summary(childBytes), gzipMedian: quantile([...perChild.values()].map((c) => c.gzip), 0.5), generatedMainBytes: summary([...perChild.values()].map((c) => c.main)) },
  sharedEntryPoints: [...perChild.values()].filter((c) => c.entries.length > 1).map((c) => c.entries),
};
results.missing = [
  "Deployed-edge cold/warm latency and CPU: nothing was deployed (FORG-30 brief: no real Cloudflare account).",
  "CPU time per child load: local workerd does not report CPU time.",
  "Loader eviction behaviour: the local loader kept every child warm for the run; when a deployed loader evicts (docs: reuse 'is not guaranteed') was not observed.",
  "Memory per child isolate: not reported locally.",
  "Cron entry points through the host: Cron Triggers are not fired by these runs (scheduled() is wired, untested).",
  "Realtime (Durable Object) entry point: not linked.",
];
writeFileSync(join(here, "results.json"), stableJson(results));
console.log(JSON.stringify({ host: { cold: results.host.coldClientWallMs, warm: results.host.warm["/v1/customers"] }, swap: results.host.swap, conformance: Object.fromEntries(Object.entries(conformance).map(([k, v]: any) => [k, `${v.passed}/${v.total}`])) }, null, 1));
