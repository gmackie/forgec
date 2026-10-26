// FORG-36: capability calls from a WASM unit. PriceCart reads one Product per item through its
// declared `Product read` capability. Plans examples/pricing with the real `forgec`, seals the unit
// as a js-module and as a Rust wasm-component (transpiled with JSPI), and runs both in workerd
// behind the same caller, reading from the same D1-backed resource store.
//
// FORG-41: concurrent calls on one isolate interleave for the wasm-component as they do for the
// js-module (an instance per in-flight call, from a pool), and a trap mid-call discards only its
// own instance.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { bindUnit, CALLER, D1_RESOURCE_HOST, D1_RESOURCE_HOST_SCHEMA, type BoundUnit, type WorkerModule } from "../src/harness.ts";
import { seal, type Sealed, type UnitPlan } from "../src/index.ts";
import { asyncImports, type Lowering } from "../src/wit-lowering.ts";
import { priceCartIn, type PriceCartInput, type Product } from "../../../examples/pricing/impl/cart.ts";

const root = resolve(import.meta.dirname, "../../..");
const forgec = join(root, "target/debug/forgec");
const pricing = join(root, "examples/pricing");
const SYMBOL = "@acme/pricing/_/PriceCart";
const PRODUCT = "@acme/pricing/_/Product";
const COMPONENT = "impl/price-cart.wasm";
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

function planOf(app: string): UnitPlan {
  const out = tmp("forge-async-plan-");
  execFileSync(forgec, ["build", app, "--units", "--out", out], { stdio: "pipe" });
  return JSON.parse(readFileSync(join(out, "units/plan.json"), "utf8")) as UnitPlan;
}

/** A copy of examples/pricing with an edited declaration, sharing the real node_modules. */
function editedPricing(edit: (src: string) => string): string {
  const app = join(tmp("forge-async-app-"), "pricing");
  for (const part of ["src", "impl", "forge.toml", "package.json"]) cpSync(join(pricing, part), join(app, part), { recursive: true });
  symlinkSync(join(pricing, "node_modules"), join(app, "node_modules"), "dir");
  const f = join(app, "src/index.forge");
  const text = readFileSync(f, "utf8");
  const next = edit(text);
  expect(next).not.toBe(text);
  writeFileSync(f, next);
  return app;
}

const unitOf = (s: Sealed) => s.manifest.units[s.bySymbol.get(SYMBOL)!]!;

// ------------------------------------------------------------------ the catalog and the carts

/** Deterministic PRNG (mulberry32), so a failing input can be reproduced. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(36);
const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const price = () => {
  const whole = String(int(0, 5000));
  const places = int(0, 2);
  return places === 0 ? whole : `${whole}.${String(int(0, 10 ** places - 1)).padStart(places, "0")}`;
};
const CATALOG: Product[] = [
  ...Array.from({ length: 40 }, (_, i): Product => ({ id: `p-${i}`, sku: `SKU-${i}`, unitPrice: price(), active: i % 7 !== 6 })),
  { id: "free", sku: "FREE", unitPrice: "0", active: true },
  { id: "unicode", sku: "çà-☃-𝄞", unitPrice: "1.01", active: true },
  { id: "huge", sku: "HUGE", unitPrice: "999999999999999999999999999999.99", active: true },
];
const byId = new Map(CATALOG.map((p) => [p.id, p]));
const ACTIVE = CATALOG.filter((p) => p.active && p.id.startsWith("p-"));

const item = (product: string, quantity: number) => ({ product, quantity });
const CASES: Array<[string, PriceCartInput]> = [
  ["one item", { items: [item("p-0", 3)] }],
  ["several items", { items: [item("p-1", 1), item("p-2", 2), item("p-3", 5)] }],
  ["the same product twice", { items: [item("p-4", 1), item("p-4", 9)] }],
  ["free product", { items: [item("free", 4)] }],
  ["unicode sku", { items: [item("unicode", 2)] }],
  ["empty cart", { items: [] }],
  ["inactive product", { items: [item("p-0", 1), item("p-6", 1)] }],
  ["missing product: the handle's NotFound passes through", { items: [item("p-0", 1), item("nope", 1)] }],
  ["i128 overflow", { items: [item("huge", Number.MAX_SAFE_INTEGER)] }],
  ["100 active items", { items: Array.from({ length: 100 }, (_, i) => item(ACTIVE[i % ACTIVE.length]!.id, (i % 5) + 1)) }],
];

function generated(n: number): PriceCartInput[] {
  return Array.from({ length: n }, () => ({
    items: Array.from({ length: int(0, 12) }, () => {
      const roll = r();
      const product = roll < 0.03 ? `missing-${int(0, 9)}` : roll < 0.04 ? "huge" : `p-${int(0, 39)}`;
      return item(product, product === "huge" ? int(1, 3) * 1_000_000_000_000 : int(1, 50));
    }),
  }));
}

/** The reference: the cart logic over an in-memory catalog, outside any unit or Worker. */
const reference = (input: PriceCartInput) => priceCartIn(input, byId);

/**
 * FORG-51: each phase is logged with its duration as it ends, so a run that hits its timeout on a
 * loaded CI runner shows where the time went (workerd start, the D1 seed, or the calls).
 */
async function worker<T>(bound: BoundUnit, f: (mf: Miniflare) => Promise<T>, label = bound.kind): Promise<T> {
  let at = performance.now();
  const phase = (name: string) => {
    const now = performance.now();
    console.log(`[wasm-async] ${label}: ${name} ${Math.round(now - at)} ms`);
    at = now;
  };
  const mf = new Miniflare({ modules: bound.modules, compatibilityDate: "2026-07-01", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB");
    phase("workerd start");
    await db.exec(D1_RESOURCE_HOST_SCHEMA);
    await db.batch(CATALOG.map((p) => db.prepare("INSERT INTO forge_harness_records (resource, id, body) VALUES (?, ?, ?)").bind(PRODUCT, p.id, JSON.stringify(p))));
    phase("D1 seed");
    const out = await f(mf);
    phase("calls");
    return out;
  } finally {
    await mf.dispose();
  }
}

async function run(bound: BoundUnit, inputs: unknown[]): Promise<unknown[]> {
  return worker(bound, async (mf) => {
    const res = await mf.dispatchFetch("http://unit/batch", { method: "POST", body: JSON.stringify(inputs) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as unknown[];
  }, `${bound.kind} x${inputs.length}`);
}

// ------------------------------------------------------------------ concurrency (FORG-41)

/**
 * Every read waits 20 ms and is logged. `trap-*` answers a price the Rust unit cannot parse, so it
 * aborts (a WASM trap) after the call's earlier reads; the JS unit throws on it.
 */
const SLOW_HOST = `export const log = [];
export function capability() {
  return {
    async get(id) {
      log.push(id);
      await scheduler.wait(20);
      return { ok: true, value: { id, sku: id.toUpperCase(), unitPrice: id.startsWith("trap-") ? "not-a-price" : "1.25", active: true } };
    },
  };
}
`;
const CONCURRENT_CALLER = `import * as bound from "./bound.js";
import { log } from "./host.js";
const cart = (tag, n, last = "") => ({ items: Array.from({ length: n }, (_, i) => ({ product: (i === n - 1 ? last : "") + tag + "-" + (i + 1), quantity: 1 })) });
const settle = (p) => Promise.race([p.then((r) => (r.ok ? r.value.subtotal : r.code), (e) => "threw: " + String(e.message ?? e)), scheduler.wait(5000).then(() => "hung")]);
const invoke = (input) => bound.invoke(input);
export default { async fetch(request) {
  await bound.ready();
  const { c } = await request.json();
  log.length = 0;
  let t0 = performance.now();
  await settle(invoke(cart("solo", 4)));
  const oneMs = performance.now() - t0;
  log.length = 0;
  t0 = performance.now();
  const concurrent = await Promise.all(Array.from({ length: c }, (_, k) => settle(invoke(cart("c" + k, 4)))));
  const concurrentMs = performance.now() - t0;
  const readOrder = [...log];
  // A trap mid-call, while two good calls are suspended; then more calls, sequential and concurrent.
  const during = await Promise.all([settle(invoke(cart("a", 3))), settle(invoke(cart("x", 3, "trap-"))), settle(invoke(cart("b", 3)))]);
  const after = [await settle(invoke(cart("after1", 3))), await settle(invoke(cart("after2", 3)))];
  const afterConcurrent = await Promise.all([settle(invoke(cart("y", 3))), settle(invoke(cart("z", 3)))]);
  return Response.json({ oneMs, concurrentMs, concurrent, readOrder, during, after, afterConcurrent, stats: bound.stats?.() ?? null });
}};
`;
interface ConcurrentRun {
  oneMs: number;
  concurrentMs: number;
  concurrent: string[];
  readOrder: string[];
  during: string[];
  after: string[];
  afterConcurrent: string[];
  stats: Record<string, number> | null;
}

async function concurrently(bound: BoundUnit, c: number): Promise<ConcurrentRun> {
  const enc = (s: string) => new TextEncoder().encode(s);
  const swap = (m: WorkerModule): WorkerModule => (m.path === "caller.js" ? { ...m, contents: enc(CONCURRENT_CALLER) } : m.path === "host.js" ? { ...m, contents: enc(SLOW_HOST) } : m);
  const mf = new Miniflare({ modules: bound.modules.map(swap), compatibilityDate: "2026-07-01" });
  try {
    const res = await mf.dispatchFetch("http://unit/", { method: "POST", body: JSON.stringify({ c }) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as ConcurrentRun;
  } finally {
    await mf.dispose();
  }
}

/** True when every call made its first read before any call made its last (of `n` reads each). */
function interleaved(order: string[], n: number): boolean {
  const at = (suffix: string) => order.flatMap((id, i) => (id.endsWith(suffix) ? [i] : []));
  return Math.max(...at("-1")) < Math.min(...at(`-${n}`));
}

describe("PriceCart as a js-module and as a wasm-component with a capability import", async () => {
  const plan = planOf(pricing);
  const js = await seal(plan, pricing);
  const wasm = await seal(plan, pricing, { components: { [SYMBOL]: COMPONENT } });

  it("plans a world that imports the read, matching the one the Rust crate is built against", () => {
    const u = plan.units.find((x) => x.symbol === SYMBOL)!;
    expect(u.imports.map((i) => i.capability)).toEqual([`resource:${PRODUCT}#read`]);
    const wit = u.wit as Extract<NonNullable<typeof u.wit>, { status: "ok" }>;
    expect(wit.status).toBe("ok");
    expect(wit.world).toBe(readFileSync(join(pricing, "impl/price-cart-rs/wit/unit.wit"), "utf8"));
    expect(asyncImports(wit.lowering as Lowering)).toEqual(["forge:unit/resource-product-read#get"]);
  });

  it("shares the interface hash, which covers the Product record the capability reaches", () => {
    const [a, b] = [unitOf(js), unitOf(wasm)];
    expect([a.kind, b.kind]).toEqual(["js-module", "wasm-component"]);
    expect(b.interfaceHash).toBe(a.interfaceHash);
    expect(b.implementationHash).not.toBe(a.implementationHash);
    const iface = plan.units.find((x) => x.symbol === SYMBOL)!.interface as { types: Record<string, unknown>; capabilitySignatures: Record<string, unknown> };
    expect(Object.keys(iface.types)).toContain(`${PRODUCT}.Record`);
    expect(iface.capabilitySignatures).toEqual({ [`resource:${PRODUCT}#read`]: { record: `${PRODUCT}.Record` } });
  });

  it("changing the reached resource's shape changes interfaceHash, and the committed component no longer seals", async () => {
    // Product is reached only through `uses { Product read }`: not PriceCart's input or output.
    const app = editedPricing((t) => t.replace("  active : boolean = true\n", "  active : boolean = true\n  weightGrams : integer?\n"));
    const edited = planOf(app);
    const before = plan.units.find((x) => x.symbol === SYMBOL)!;
    const after = edited.units.find((x) => x.symbol === SYMBOL)!;
    expect(after.interfaceHash).not.toBe(before.interfaceHash);
    expect((after.wit as { digest: string }).digest).not.toBe((before.wit as { digest: string }).digest);
    // A pure unit in the same package keeps its interface.
    const quote = (p: UnitPlan) => p.units.find((x) => x.symbol === "@acme/pricing/_/QuoteOrder")!.interfaceHash;
    expect(quote(edited)).toBe(quote(plan));
    await expect(seal(edited, app, { components: { [SYMBOL]: COMPONENT } })).rejects.toThrow(/differs from the WIT forgec generated for this unit/);
  });

  describe("in workerd, behind one caller, over one D1 resource store", async () => {
    const [boundJs, boundWasm] = await Promise.all([bindUnit(js, SYMBOL, pricing, { host: D1_RESOURCE_HOST }), bindUnit(wasm, SYMBOL, pricing, { host: D1_RESOURCE_HOST })]);
    const inputs = [...CASES.map(([, i]) => i), ...generated(200)];

    it("ships the same caller and host to both, and JSPI glue for the component", () => {
      const file = (b: BoundUnit, p: string) => b.modules.find((m) => m.path === p)!.contents;
      expect(new TextDecoder().decode(file(boundJs, "caller.js"))).toBe(CALLER);
      expect(Buffer.compare(file(boundJs, "caller.js"), file(boundWasm, "caller.js"))).toBe(0);
      expect(Buffer.compare(file(boundJs, "host.js"), file(boundWasm, "host.js"))).toBe(0);
      expect(boundWasm.modules.map((m) => `${m.type} ${m.path}`)).toEqual(["ESModule caller.js", "ESModule bound.js", "ESModule host.js", "ESModule unit.js", "CompiledWasm unit.core.wasm", "CompiledWasm unit.core2.wasm", "CompiledWasm unit.core3.wasm"]);
      const glue = new TextDecoder().decode(file(boundWasm, "unit.js"));
      expect(glue).toMatch(/\.Suspending\(/);
      expect(glue).toMatch(/\.promising\(/);
    });

    it("gives identical outputs on every input (differential)", async () => {
      const [a, b] = await Promise.all([run(boundJs, inputs), run(boundWasm, inputs)]);
      expect(a).toHaveLength(inputs.length);
      for (let i = 0; i < inputs.length; i++) expect(b[i], CASES[i]?.[0] ?? `generated #${i - CASES.length}`).toEqual(a[i]);
      // And both are the reference logic over the same catalog, not merely each other.
      expect(a).toEqual(inputs.map(reference));
      const codes = (xs: unknown[]) => xs.slice(0, CASES.length).map((x) => ((x as { ok: boolean }).ok ? "ok" : (x as { code: string }).code));
      expect(codes(a)).toEqual(["ok", "ok", "ok", "ok", "ok", "EmptyCart", "InactiveProduct", "NotFound", "CartTooLarge", "ok"]);
      // The generated carts exercise every outcome too.
      const seen = new Set(b.slice(CASES.length).map((x) => ((x as { ok: boolean }).ok ? "ok" : (x as { code: string }).code)));
      expect([...seen].sort()).toEqual(["CartTooLarge", "EmptyCart", "InactiveProduct", "NotFound", "ok"]);
      // About 4 s on a developer machine; one run took over 120 s on a loaded shared runner (FORG-51).
    }, 300_000);

    describe("concurrent calls on one isolate (FORG-41)", async () => {
      const C = 8;
      const [pooled, shared, plainJs] = await Promise.all([bindUnit(wasm, SYMBOL, pricing), bindUnit(wasm, SYMBOL, pricing, { instances: "shared" }), bindUnit(js, SYMBOL, pricing)]);
      // One at a time: the timings below compare runs on a possibly loaded machine.
      const w = await concurrently(pooled, C);
      const s = await concurrently(shared, C);
      const j = await concurrently(plainJs, C);

      it("interleaves wasm calls like JS calls: no serialization behind a suspended call", () => {
        for (const r of [w, j]) {
          expect(r.concurrent).toEqual(Array.from({ length: C }, () => "5.00"));
          expect(interleaved(r.readOrder, 4), r.readOrder.join(" ")).toBe(true);
          // Every call's first read happens before any call's second: the reads go out in waves.
          expect(new Set(r.readOrder.slice(0, C).map((id) => id.slice(id.lastIndexOf("-"))))).toEqual(new Set(["-1"]));
          // 8 calls of 4 sequential 20 ms reads, at once: serialized they take 8x one call. The bound is
          // loose (half of that) because the order above is the proof; this only checks the clock agrees.
          expect(r.concurrentMs, `one ${r.oneMs} ms, ${C} at once ${r.concurrentMs} ms`).toBeLessThan((r.oneMs * C) / 2);
        }
        expect(w.stats).toMatchObject({ peak: C, created: C, discarded: 1 });
      });

      it("serializes on one shared instance (the binding before FORG-41), which is what the pool removes", () => {
        expect(s.concurrent).toEqual(Array.from({ length: C }, () => "5.00"));
        expect(interleaved(s.readOrder, 4)).toBe(false);
        expect(s.readOrder.slice(0, 4)).toEqual(["c0-1", "c0-2", "c0-3", "c0-4"]);
        expect(s.concurrentMs).toBeGreaterThan(s.oneMs * (C / 2));
      });

      it("a trap mid-call discards only its own instance: suspended and later calls are unaffected", () => {
        expect(w.during[0]).toBe("3.75");
        expect(w.during[1]).toMatch(/^threw: .*unreachable/);
        expect(w.during[2]).toBe("3.75");
        expect([...w.after, ...w.afterConcurrent]).toEqual(["3.75", "3.75", "3.75", "3.75"]);
        // The same as the JS unit, whose body throws on the bad price.
        expect(j.during[0]).toBe("3.75");
        expect(j.during[1]).toMatch(/^threw: /);
        expect([j.during[2], ...j.after, ...j.afterConcurrent]).toEqual(["3.75", "3.75", "3.75", "3.75", "3.75"]);
      });

      it("a trap poisons a shared instance for every later call", () => {
        expect(s.during[0]).toBe("3.75");
        expect(s.during[1]).toMatch(/^threw: .*unreachable/);
        for (const r of [...s.after, ...s.afterConcurrent]) expect(r).toMatch(/^threw: .*cannot enter component instance/);
      });
    });

    it("fails closed when the host does not provide a declared capability", async () => {
      const [noJs, noWasm] = await Promise.all([bindUnit(js, SYMBOL, pricing), bindUnit(wasm, SYMBOL, pricing)]);
      for (const b of [noJs, noWasm]) {
        await worker(b, async (mf) => {
          const res = await mf.dispatchFetch("http://unit/call", { method: "POST", body: JSON.stringify(CASES[0]![1]) });
          expect(res.status).toBe(500);
          expect(await res.text()).toMatch(/is a declared capability of this unit, and the host does not provide it/);
        });
      }
    });
  });
});
