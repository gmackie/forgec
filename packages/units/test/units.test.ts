// End to end over the reference app: `forgec build --units` on a scratch copy of examples/acme,
// then seal. Checks reproducibility, which edits move which hashes, and the schema.
import Ajv2020 from "ajv/dist/2020.js";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { seal, writeSealed, type ClosureManifest, type UnitPlan } from "../src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const forgec = join(root, "target/debug/forgec");
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A copy of acme + payments outside the repository, so absolute paths cannot leak into outputs. */
function copyAcme(edit?: (app: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-units-"));
  scratch.push(dir);
  const app = join(dir, "acme");
  for (const part of ["src", "impl", "forge.toml", "forge.lock", "package.json", "tsconfig.json"]) cpSync(join(root, "examples/acme", part), join(app, part), { recursive: true });
  cpSync(join(root, "examples/payments"), join(dir, "payments"), { recursive: true });
  // Extension manifests are pinned relative to the repository; the digest pins their content.
  const toml = join(app, "forge.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replaceAll('"../../packages/', `"${root}/packages/`));
  symlinkSync(join(root, "examples/acme/node_modules"), join(app, "node_modules"), "dir");
  edit?.(app);
  return app;
}

async function build(app: string): Promise<{ manifest: ClosureManifest; out: string; bySymbol: Map<string, string> }> {
  execFileSync(forgec, ["build", app, "--units"], { stdio: "pipe" });
  const out = join(app, "generated/units");
  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as UnitPlan;
  const sealed = await seal(plan, app);
  writeSealed(sealed, out);
  return { manifest: sealed.manifest, out, bySymbol: sealed.bySymbol };
}

const unit = (b: Awaited<ReturnType<typeof build>>, name: string) => {
  const h = [...b.bySymbol].find(([s]) => s.endsWith(`/${name}`))?.[1];
  if (!h) throw new Error(`no unit ${name}`);
  return { unitHash: h, ...b.manifest.units[h]! };
};

const files = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name !== "plan.json")
    .map((d) => join(d.parentPath, d.name))
    .sort()
    .map((f) => [f.slice(dir.length), readFileSync(f)] as const);

describe("closure manifest for examples/acme", async () => {
  const base = await build(copyAcme());

  it("is byte-identical across two builds in different directories", async () => {
    const again = await build(copyAcme());
    const [a, b] = [files(base.out), files(again.out)];
    expect(a.map(([f]) => f)).toEqual(b.map(([f]) => f));
    for (let i = 0; i < a.length; i++) expect(Buffer.compare(a[i]![1], b[i]![1]), a[i]![0]).toBe(0);
    expect(again.manifest.manifestHash).toBe(base.manifest.manifestHash);
  });

  it("validates against schemas/closure-manifest.schema.json", () => {
    const schema = JSON.parse(readFileSync(join(root, "schemas/closure-manifest.schema.json"), "utf8"));
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const ok = validate(JSON.parse(readFileSync(join(base.out, "manifest.json"), "utf8")));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("bundles each js-module unit from only its own impl file", () => {
    const js = Object.values(base.manifest.units).filter((u) => u.kind === "js-module");
    expect(js.map((u) => u.symbol).sort()).toEqual(["@acme/commerce/_/FulfillOrder", "@acme/commerce/_/RebuildOrderSummary", "@acme/commerce/_/SubmitOrder", "@acme/payments/_/AuthorizePayment"]);
    const sources = Object.fromEntries(js.map((u) => [u.symbol.split("/").pop(), base.manifest.modules[u.implementation["module"] as string]!.sources]));
    expect(sources).toEqual({
      FulfillOrder: ["impl/fulfill-order.ts"],
      RebuildOrderSummary: ["impl/rebuild-order-summary.ts"],
      SubmitOrder: ["impl/submit-order.ts"],
      AuthorizePayment: ["impl/payment-adapter.ts"],
    });
  });

  it("changing an impl body re-identifies only that unit and the closures that contain it", async () => {
    const edited = await build(
      copyAcme((app) => {
        const f = join(app, "impl/rebuild-order-summary.ts");
        writeFileSync(f, readFileSync(f, "utf8").replace("{ rebuilt: true }", "{ rebuilt: false }"));
      }),
    );
    const [a, b] = [unit(base, "RebuildOrderSummary"), unit(edited, "RebuildOrderSummary")];
    expect(b.interfaceHash).toBe(a.interfaceHash);
    expect(b.implementationHash).not.toBe(a.implementationHash);
    expect(b.unitHash).not.toBe(a.unitHash);
    // Callers depend on the interface, so ProcessOrder keeps its identity; no other unit moves.
    expect(unit(edited, "ProcessOrder").unitHash).toBe(unit(base, "ProcessOrder").unitHash);
    const moved = [...edited.bySymbol].filter(([s, h]) => base.bySymbol.get(s) !== h).map(([s]) => s);
    expect(moved).toEqual(["@acme/commerce/_/RebuildOrderSummary"]);
    // The exact implementation is pinned by every entry point whose closure contains it.
    const before = new Map(base.manifest.entryPoints.map((e) => [e.id, e]));
    let containing = 0;
    for (const e of edited.manifest.entryPoints) {
      const old = before.get(e.id)!;
      const contains = old.closure.includes(a.unitHash);
      if (contains) containing++;
      expect(e.closure.includes(b.unitHash), e.id).toBe(contains);
      expect(e.closureHash !== old.closureHash, e.id).toBe(contains);
    }
    // the schedule's cron and manual-tick route, the workflow step, the workflow class, its start and
    // signal routes, and the sweep (FORG-33: the sweep's closure is the dispatch unit's)
    expect(containing).toBe(7);
  });

  it("changing a signature changes both interfaceHash and unitHash", async () => {
    const edited = await build(
      copyAcme((app) => {
        const f = join(app, "src/orders/fulfillment.forge");
        const text = readFileSync(f, "utf8");
        const next = text.replace("function RebuildOrderSummary {\n  uses {\n    Order read\n  }\n}", "function RebuildOrderSummary {\n  uses {\n    Order read\n  }\n\n  errors {\n    Stale\n  }\n}");
        expect(next).not.toBe(text);
        writeFileSync(f, next);
      }),
    );
    const [a, b] = [unit(base, "RebuildOrderSummary"), unit(edited, "RebuildOrderSummary")];
    expect(b.interfaceHash).not.toBe(a.interfaceHash);
    expect(b.unitHash).not.toBe(a.unitHash);
    expect(b.implementationHash).toBe(a.implementationHash);
    // A caller's identity covers the interfaces it calls, so ProcessOrder moves with this one.
    expect(unit(edited, "ProcessOrder").interfaceHash).toBe(unit(base, "ProcessOrder").interfaceHash);
    expect(unit(edited, "ProcessOrder").unitHash).not.toBe(unit(base, "ProcessOrder").unitHash);
  });

  it("refuses a plan whose js-module unit has no implementation", async () => {
    const app = copyAcme();
    execFileSync(forgec, ["build", app, "--units"], { stdio: "pipe" });
    const plan = JSON.parse(readFileSync(join(app, "generated/units/plan.json"), "utf8")) as UnitPlan;
    writeFileSync(join(app, "impl/index.ts"), readFileSync(join(app, "impl/index.ts"), "utf8").replace(/export const externals = \{[^}]*\};/, "export const externals = {};"));
    await expect(seal(plan, app)).rejects.toThrow(/missing unit: @acme\/payments\/_\/AuthorizePayment/);
  });

  it("maps entry points to closures and runtime-provided imports", () => {
    const route = base.manifest.entryPoints.find((e) => e.id === "POST /v1/orders/{order}/submit")!;
    const submit = unit(base, "SubmitOrder");
    expect(route.root).toBe(submit.unitHash);
    expect(route.closure.map((h) => base.manifest.units[h]!.symbol).sort()).toEqual(["@acme/commerce/_/Order.status.submit", "@acme/commerce/_/SubmitOrder", "@acme/payments/_/AuthorizePayment"]);
    expect(route.bindings).toEqual([
      { type: "d1", name: "DB" },
      { type: "durable-object", name: "REALTIME" },
      { type: "queue-producer", name: "Q_FULFILL_ORDER" },
    ]);
    const sweep = base.manifest.entryPoints.find((e) => e.id === "forge:sweep")!;
    expect(sweep.root).toBe(unit(base, "dispatch").unitHash);
    expect(sweep.runtimeService).toBe("outbox-and-workflow-sweep");
  });

  it("covers every surface the runtime serves (FORG-33)", () => {
    const m = base.manifest;
    expect(m.uncovered).toEqual([]);
    const ids = new Set(m.entryPoints.map((e) => e.id));
    for (const id of [
      "GET /v1/views/pending-orders",
      "GET /v1/customer-order-summaries/{id}",
      "POST /v1/customer-order-summaries/rebuild",
      "GET /v1/caches/current-site-policy",
      "GET /v1/schedules/nightly-reconciliation",
      "POST /v1/schedules/nightly-reconciliation/tick",
      "POST /v1/changesets",
      "POST /v1/changesets/{id}/commit",
      "POST /v1/imports/stage",
      "POST /v1/admin/export",
      "GET /forge/discovery",
      "GET /_forge/objects/{token}",
      "GET /v1/live/orders",
      "projection:CustomerOrderSummary",
    ])
      expect(ids.has(id), id).toBe(true);
    const roles = (id: string) => m.entryPoints.find((e) => e.id === id)!.closure.map((h) => m.units[h]!.role);
    expect(roles("GET /v1/views/pending-orders").sort()).toEqual(["operation", "view"]);
    expect(roles("POST /v1/imports/stage")).toContain("service");
    // The implicit channel: audited operations publish it, the projection's subscription consumes it.
    const create = unit(base, "Order.create");
    expect(create.imports.map((i) => i.capability)).toContain("send:@acme/commerce/_/Order.changes#Created");
    const sub = m.entryPoints.find((e) => e.id === "projection:CustomerOrderSummary")!;
    expect(sub.kind).toBe("subscription");
    expect((sub.trigger as { channel: string }).channel).toBe("@acme/commerce/_/Order.changes");
    // Cancelling wakes the native instance, so the cancel route declares the workflow binding.
    expect(m.entryPoints.find((e) => e.id === "POST /v1/workflows/process-order/{id}/cancel")!.bindings).toEqual([{ type: "workflow", name: "WF_PROCESS_ORDER" }]);
    expect(m.hostBindings.map((b) => b.name)).toContain("FORGE_CORS");
  });
});

describe("unit sources (FORG-33)", async () => {
  const app = copyAcme();
  const base = await build(app);
  const text = (pkgRoot: string, path: string, start: number, end: number) => readFileSync(join(pkgRoot, path)).subarray(start, end).toString("utf8");
  const pkgRoot = (s: { package?: string }) => (s.package === "@acme/payments" ? join(app, "../payments") : app);

  it("records the .forge declaration and the impl/ body, each with its file's git blob hash", () => {
    const m = base.manifest;
    const submit = unit(base, "SubmitOrder");
    expect(submit.sources.map((s) => [s.part, s.path])).toEqual([
      ["declaration", "src/orders/fulfillment.forge"],
      ["body", "impl/submit-order.ts"],
    ]);
    const [decl, body] = submit.sources;
    expect(text(app, decl!.path, decl!.start, decl!.end)).toMatch(/function SubmitOrder\b/);
    expect(text(app, body!.path, body!.start, body!.end)).toMatch(/^export const \w+ = defineFunction\("@acme\/commerce\/_\/SubmitOrder"/);
    // An external is declared by the package that exports it and implemented by the deployment.
    const authorize = unit(base, "AuthorizePayment");
    expect(authorize.sources.map((s) => [s.part, s.package ?? null, s.path])).toEqual([
      ["declaration", "@acme/payments", "src/index.forge"],
      ["body", null, "impl/payment-adapter.ts"],
    ]);
    // A generated operation is declared by its resource.
    const [op] = unit(base, "Order.create").sources;
    expect(text(app, op!.path, op!.start, op!.end)).toMatch(/^export resource Order\b/);
    for (const u of Object.values(m.units)) {
      if (u.role === "service") expect(u.sources, u.symbol).toEqual([]);
      else expect(u.sources.length, u.symbol).toBeGreaterThan(0);
      for (const s of u.sources) {
        const file = join(pkgRoot(s), s.path);
        expect(execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim(), `${u.symbol} ${s.path}`).toBe(s.gitBlob);
        expect(s.end).toBeGreaterThan(s.start);
        expect(s.end).toBeLessThanOrEqual(readFileSync(file).byteLength);
      }
    }
  });

  it("moving a declaration or a body changes its spans and the manifest hash, never a unit or closure hash", async () => {
    const moved = await build(
      copyAcme((a) => {
        const f = join(a, "src/orders/fulfillment.forge");
        writeFileSync(f, `// moved down by a comment\n${readFileSync(f, "utf8")}`);
        const g = join(a, "impl/submit-order.ts");
        writeFileSync(g, `// moved down by a comment\n${readFileSync(g, "utf8")}`);
      }),
    );
    const [a, b] = [unit(base, "SubmitOrder"), unit(moved, "SubmitOrder")];
    expect(b.sources.map((s) => s.start)).toEqual(a.sources.map((s) => s.start + "// moved down by a comment\n".length));
    expect(b.sources.map((s) => s.gitBlob)).not.toEqual(a.sources.map((s) => s.gitBlob));
    expect([b.interfaceHash, b.implementationHash, b.unitHash]).toEqual([a.interfaceHash, a.implementationHash, a.unitHash]);
    expect([...moved.bySymbol]).toEqual([...base.bySymbol]);
    expect(moved.manifest.entryPoints.map((e) => e.closureHash)).toEqual(base.manifest.entryPoints.map((e) => e.closureHash));
    expect(moved.manifest.manifestHash).not.toBe(base.manifest.manifestHash);
  });

  it("refuses to seal a plan whose .forge files changed after forgec planned them", async () => {
    const stale = copyAcme();
    execFileSync(forgec, ["build", stale, "--units"], { stdio: "pipe" });
    const plan = JSON.parse(readFileSync(join(stale, "generated/units/plan.json"), "utf8")) as UnitPlan;
    const f = join(stale, "src/orders/fulfillment.forge");
    writeFileSync(f, `${readFileSync(f, "utf8")}\n`);
    await expect(seal(plan, stale)).rejects.toThrow(/stale plan: src\/orders\/fulfillment\.forge changed since forgec planned/);
  });
});
