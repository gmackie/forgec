// FORG-31: a Rust WASM component and a JS module behind one interface. Plans examples/pricing with
// the real `forgec`, seals it both ways, and runs both in workerd behind the same caller.
import Ajv2020 from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { bindUnit, CALLER, HOST_RUNTIME, type BoundUnit } from "../src/harness.ts";
import { seal, type Sealed, type UnitPlan } from "../src/index.ts";
import { quote, type QuoteOrderInput } from "../../../examples/pricing/impl/quote.ts";
import { defineFunction } from "../../runtime/src/functions.ts";

const root = resolve(import.meta.dirname, "../../..");
const forgec = join(root, "target/debug/forgec");
const pricing = join(root, "examples/pricing");
const SYMBOL = "@acme/pricing/_/QuoteOrder";
const COMPONENT = "impl/quote-order.wasm";
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

function planOf(app: string): UnitPlan {
  const out = tmp("forge-wasm-plan-");
  execFileSync(forgec, ["build", app, "--units", "--out", out], { stdio: "pipe" });
  return JSON.parse(readFileSync(join(out, "units/plan.json"), "utf8")) as UnitPlan;
}

/** A copy of examples/pricing with an edited declaration, sharing the real node_modules. */
function editedPricing(edit: (src: string) => string): string {
  const app = join(tmp("forge-wasm-app-"), "pricing");
  for (const part of ["src", "impl", "forge.toml", "package.json"]) cpSync(join(pricing, part), join(app, part), { recursive: true });
  symlinkSync(join(pricing, "node_modules"), join(app, "node_modules"), "dir");
  const f = join(app, "src/index.forge");
  const text = readFileSync(f, "utf8");
  const next = edit(text);
  expect(next).not.toBe(text);
  writeFileSync(f, next);
  return app;
}

const unitOf = (s: Sealed) => {
  const h = s.bySymbol.get(SYMBOL)!;
  return { unitHash: h, ...s.manifest.units[h]! };
};

// ------------------------------------------------------------------ differential inputs

const line = (sku: string, quantity: number, unitPrice: string) => ({ sku, quantity, unitPrice });
const base: QuoteOrderInput = { lines: [line("A-1", 3, "19.99"), line("B-2", 1, "120")], tier: "gold", taxRateBasisPoints: 825, shipping: "7.5" };

/** Deterministic PRNG (mulberry32), so a failing input can be reproduced. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generated(n: number, seed: number): QuoteOrderInput[] {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const price = () => {
    const whole = String(int(0, 5000));
    const places = int(0, 2);
    return places === 0 ? whole : `${whole}.${String(int(0, 10 ** places - 1)).padStart(places, "0")}`;
  };
  const tiers = ["standard", "gold", "enterprise"] as const;
  return Array.from({ length: n }, (_, i) => ({
    lines: Array.from({ length: int(1, 12) }, (_, j) => line(`SKU-${i}-${j}`, int(1, 50), price())),
    tier: tiers[int(0, 2)]!,
    taxRateBasisPoints: int(0, 2_500),
    ...(r() < 0.5 ? { shipping: price() } : r() < 0.5 ? { shipping: null } : {}),
  }));
}

const CASES: Array<[string, QuoteOrderInput]> = [
  ["base", base],
  ["standard tier, no shipping", { ...base, tier: "standard", shipping: null }],
  ["enterprise, shipping absent", { lines: base.lines, tier: "enterprise", taxRateBasisPoints: 0 }],
  ["half-up rounding at .5 cent", { lines: [line("H", 1, "0.10")], tier: "gold", taxRateBasisPoints: 5_000 }],
  ["amount spellings 12 / 12.5 / 12.50", { lines: [line("a", 1, "12"), line("b", 1, "12.5"), line("c", 1, "12.50")], tier: "standard", taxRateBasisPoints: 1 }],
  ["all lines free: no top sku", { lines: [line("free", 4, "0"), line("gratis", 1, "0.00")], tier: "gold", taxRateBasisPoints: 900 }],
  ["tie keeps the first line", { lines: [line("first", 2, "5"), line("second", 1, "10")], tier: "standard", taxRateBasisPoints: 0 }],
  ["unicode sku", { lines: [line("çà-☃-𝄞", 1, "1.01")], tier: "standard", taxRateBasisPoints: 10_000 }],
  ["empty order", { ...base, lines: [] }],
  ["tax rate above 100%", { ...base, taxRateBasisPoints: 10_001 }],
  ["total over the limit", { lines: [line("big", 1, "100000000.01")], tier: "standard", taxRateBasisPoints: 0 }],
  ["just under the limit", { lines: [line("big", 1, "100000000.00")], tier: "standard", taxRateBasisPoints: 0 }],
  ["i128 overflow", { lines: [line("huge", Number.MAX_SAFE_INTEGER, "999999999999999999999999999999.99")], tier: "standard", taxRateBasisPoints: 0 }],
  ["1000 lines", { lines: Array.from({ length: 1_000 }, (_, i) => line(`L${i}`, (i % 7) + 1, `${i}.${String(i % 100).padStart(2, "0")}`)), tier: "enterprise", taxRateBasisPoints: 725, shipping: "15" }],
];

async function run(bound: BoundUnit, inputs: unknown[]): Promise<unknown[]> {
  const mf = new Miniflare({ modules: bound.modules, compatibilityDate: "2026-07-01" });
  try {
    const res = await mf.dispatchFetch("http://unit/batch", { method: "POST", body: JSON.stringify(inputs) });
    expect(res.status).toBe(200);
    return (await res.json()) as unknown[];
  } finally {
    await mf.dispose();
  }
}

describe("QuoteOrder as a js-module and as a wasm-component", async () => {
  const plan = planOf(pricing);
  const js = await seal(plan, pricing);
  const wasm = await seal(plan, pricing, { components: { [SYMBOL]: COMPONENT } });

  it("plans a WIT world for the unit that matches the one the Rust crate is built against", () => {
    const u = plan.units.find((x) => x.symbol === SYMBOL)!;
    expect(u.wit?.status).toBe("ok");
    const wit = u.wit as Extract<NonNullable<typeof u.wit>, { status: "ok" }>;
    expect(wit.world).toBe(readFileSync(join(pricing, "impl/quote-order-rs/wit/unit.wit"), "utf8"));
    expect(wit.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("shares the interface hash and differs in implementation, unit and closure hashes", () => {
    const [a, b] = [unitOf(js), unitOf(wasm)];
    expect(a.kind).toBe("js-module");
    expect(b.kind).toBe("wasm-component");
    expect(b.interfaceHash).toBe(a.interfaceHash);
    expect(b.implementationHash).not.toBe(a.implementationHash);
    expect(b.unitHash).not.toBe(a.unitHash);
    expect(b.implementation).toMatchObject({ abi: "forge-wit/1", world: (plan.units.find((x) => x.symbol === SYMBOL)!.wit as { digest: string }).digest });
    // The swap pins a different closure for the route, and nothing else about the entry point moves.
    const route = (s: Sealed) => s.manifest.entryPoints.find((e) => e.id === "POST /v1/quotes")!;
    expect(route(js).root).toBe(a.unitHash);
    expect(route(wasm).root).toBe(b.unitHash);
    expect(route(wasm).closureHash).not.toBe(route(js).closureHash);
    expect({ ...route(wasm), root: null, closure: [], closureHash: null }).toEqual({ ...route(js), root: null, closure: [], closureHash: null });
    expect(wasm.manifest.toolchain.transpiler).toMatch(/^@bytecodealliance\/jco@\d/);
    expect(js.manifest.toolchain.transpiler).toBeUndefined();
  });

  it("validates against schemas/closure-manifest.schema.json both ways", () => {
    const schema = JSON.parse(readFileSync(join(root, "schemas/closure-manifest.schema.json"), "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    for (const s of [js, wasm]) {
      const ok = validate(JSON.parse(JSON.stringify(s.manifest)));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    }
    const blobs = Object.values(wasm.manifest.modules).map((m) => m.path.split(".").pop()).sort();
    expect(blobs).toEqual(["json", "wasm"]);
  });

  it("seals byte-identically twice", async () => {
    const again = await seal(plan, pricing, { components: { [SYMBOL]: COMPONENT } });
    expect(again.manifest.manifestHash).toBe(wasm.manifest.manifestHash);
  });

  it("refuses a component whose world is not the unit's generated world", async () => {
    // A new error changes the interface and so the WIT; the committed component predates it.
    const app = editedPricing((t) => t.replace("    QuoteTooLarge\n", "    QuoteTooLarge\n    Stale\n"));
    await expect(seal(planOf(app), app, { components: { [SYMBOL]: COMPONENT } })).rejects.toThrow(/differs from the WIT forgec generated for this unit/);
  });

  it("refuses a component for a unit whose interface has no WIT lowering", async () => {
    const app = editedPricing((t) => t.replace("  topSku : text?\n", "  topSku : text?\n  extra : json\n"));
    await expect(seal(planOf(app), app, { components: { [SYMBOL]: COMPONENT } })).rejects.toThrow(/no WIT world \(error\[E-WIT-001\]: output\.extra: `json` has no WIT type/);
  });

  it("refuses a component bound to a unit that is not an implemented function", async () => {
    await expect(seal(plan, pricing, { components: { "@acme/pricing/_/Nope": COMPONENT } })).rejects.toThrow(/no implemented function unit/);
  });

  describe("in workerd, behind one caller", async () => {
    const [boundJs, boundWasm] = await Promise.all([bindUnit(js, SYMBOL, pricing), bindUnit(wasm, SYMBOL, pricing)]);
    const inputs = [...CASES.map(([, i]) => i), ...generated(200, 31)];

    it("runs the same caller module bytes whichever implementation is linked", () => {
      const caller = (b: BoundUnit) => b.modules.find((m) => m.path === "caller.js")!.contents;
      expect(Buffer.compare(caller(boundJs), caller(boundWasm))).toBe(0);
      expect(new TextDecoder().decode(caller(boundJs))).toBe(CALLER);
      expect(boundWasm.modules.map((m) => `${m.type} ${m.path}`)).toEqual(["ESModule caller.js", "ESModule bound.js", "ESModule unit.js", "CompiledWasm unit.core.wasm"]);
    });

    it("gives identical outputs on every input (differential)", async () => {
      const [a, b] = await Promise.all([run(boundJs, inputs), run(boundWasm, inputs)]);
      expect(a).toHaveLength(inputs.length);
      for (let i = 0; i < inputs.length; i++) expect(b[i], CASES[i]?.[0] ?? `generated #${i - CASES.length}`).toEqual(a[i]);
      // And both are the reference arithmetic, not merely each other.
      expect(a).toEqual(inputs.map((i) => quote(i as QuoteOrderInput)));
      const failures = a.filter((r) => !(r as { ok: boolean }).ok).map((r) => (r as { code: string }).code);
      expect(failures).toEqual(["EmptyOrder", "InvalidTaxRate", "QuoteTooLarge", "QuoteTooLarge"]);
    }, 120_000);
  });

  it("the harness host's defineFunction is the runtime's", () => {
    const body = () => null as never;
    const shim = new Function(`${HOST_RUNTIME.replace("export ", "")}; return defineFunction;`)() as typeof defineFunction;
    expect(shim("x", body, { transactional: true })).toEqual(defineFunction("x", body, { transactional: true }));
    expect(shim("x", body)).toEqual(defineFunction("x", body));
  });
});

const hasToolchain = (() => {
  try {
    return execFileSync("wasm-tools", ["--version"], { encoding: "utf8" }).includes("1.262.0") && execFileSync("rustc", ["--version"], { cwd: join(pricing, "impl/quote-order-rs"), encoding: "utf8" }).includes("1.97.1");
  } catch {
    return false;
  }
})();

describe.skipIf(!hasToolchain)("impl/quote-order.wasm", () => {
  it("rebuilds byte for byte from impl/quote-order-rs in another directory", () => {
    execFileSync("node", [join(pricing, "build-component.mjs"), "--check"], { stdio: "pipe" });
  }, 300_000);
});
