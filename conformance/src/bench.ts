/**
 * Live benchmark (plan §25 M8: "performance is measured independently; target
 * values are not advertised as achieved without results"). Measures client-
 * observed latency per operation class and the physical action budget the
 * preview reports for atomic changesets of increasing size, on one deployment.
 *
 *   FORGE_TARGET_URL=... FORGE_TARGET_NAME=cloudflare-d1 pnpm bench
 *
 * Writes conformance/reports/bench-<name>.json. Numbers are for the network
 * path they were measured on and say nothing about other regions or loads.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-ignore -- executed with node --experimental-strip-types; the .ts specifier is what Node resolves
import { createClient } from "../fixtures/acme.client.ts";

const url = process.env["FORGE_TARGET_URL"];
const name = process.env["FORGE_TARGET_NAME"] ?? "target";
if (!url) throw new Error("FORGE_TARGET_URL is required");
const N = Number(process.env["FORGE_BENCH_N"] ?? 20);
const tenant = `bench-${Date.now().toString(36)}`;
const c = createClient({ baseUrl: url, tenant, actor: "bench" });

async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const v = await f();
  return [v, performance.now() - t];
}
function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(s[s.length - 1] ?? 0) };
}

const result: Record<string, unknown> = { target: name, url, at: new Date().toISOString(), samplesPerOp: N };
const lat: Record<string, number[]> = { "crud-write:create": [], "crud-read:get": [], "crud-read:list": [], "crud-write:update": [], "function:SubmitOrder": [] };

const [cust] = await timed(() => c.customers.create({ code: "BEN", name: "Bench" }));
const [site] = await timed(() => c.sites.create({ customer: cust.id, code: "hq", name: "HQ", timezone: "UTC" }));
for (let i = 0; i < N; i++) {
  const [o, t1] = await timed(() => c.orders.create({ customer: cust.id, site: site.id, subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" }));
  lat["crud-write:create"]!.push(t1);
  const [, t2] = await timed(() => c.orders.get(o.id));
  lat["crud-read:get"]!.push(t2);
  const [, t3] = await timed(() => c.orders.listByCustomer({ customer: cust.id }, { limit: 20 }));
  lat["crud-read:list"]!.push(t3);
  const [, t4] = await timed(() => c.orders.update(o.id, 1, { tax: "2.00" }));
  lat["crud-write:update"]!.push(t4);
  const [, t5] = await timed(() => c.functions.submitOrder({ order: o.id, expectedVersion: 2 }));
  lat["function:SubmitOrder"]!.push(t5);
}
result["latencyMs"] = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stats(v)]));

// Physical budget per atomic changeset size: what the preview reports on this provider.
const budgets: { operations: number; physicalActions: number; physicalLimit: number; atomicAllowed: boolean }[] = [];
for (const size of [1, 2, 5, 10]) {
  const ops = Array.from({ length: size }, (_, i) => ({ op: "@acme/commerce/_/Customer.create", input: { code: `B${size}${i}`, name: `B ${size} ${i}` } }));
  const cs = await c.changesets.propose({ mode: "atomic", operations: ops });
  const p = await c.changesets.preview(cs.id);
  const b = (p as unknown as { budget: { physicalActions: number; physicalLimit: number; atomicAllowed: boolean } }).budget;
  budgets.push({ operations: size, physicalActions: b.physicalActions, physicalLimit: b.physicalLimit, atomicAllowed: b.atomicAllowed });
}
result["atomicBudget"] = budgets;

mkdirSync(resolve(import.meta.dirname, "..", "reports"), { recursive: true });
const out = resolve(import.meta.dirname, "..", "reports", `bench-${name}.json`);
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
