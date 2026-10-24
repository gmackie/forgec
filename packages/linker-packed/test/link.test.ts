// Linker A over the reference app: `forgec build --units` and the sealer on a scratch copy of
// examples/acme, then link. Checks grouping, slicing, determinism and that every broken input is
// refused at link time; then serves the per-entry-point output in workerd and checks the routing
// and capability boundaries at request time.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { seal, writeSealed, type UnitPlan } from "@forgegraph/units";
import { link, LinkError, loadManifest, readJsonc, reseal, type Environment, type Link, type Manifest } from "../src/index.ts";
import { scriptsOf, serve } from "../src/local.ts";

const root = resolve(import.meta.dirname, "../../..");
const forgec = join(root, "target/debug/forgec");
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/** A sealed copy of acme + payments outside the repository. */
async function sealedAcme(): Promise<{ app: string; units: string; env: string }> {
  const dir = tmp("forge-link-");
  const app = join(dir, "acme");
  for (const part of ["src", "impl", "deploy", "migrations", "forge.toml", "forge.lock", "package.json", "tsconfig.json"]) cpSync(join(root, "examples/acme", part), join(app, part), { recursive: true });
  cpSync(join(root, "examples/payments"), join(dir, "payments"), { recursive: true });
  const toml = join(app, "forge.toml");
  writeFileSync(toml, readFileSync(toml, "utf8").replaceAll('"../../packages/', `"${root}/packages/`));
  symlinkSync(join(root, "examples/acme/node_modules"), join(app, "node_modules"), "dir");
  execFileSync(forgec, ["build", app, "--units"], { stdio: "pipe" });
  const units = join(app, "generated/units");
  writeSealed(await seal(JSON.parse(readFileSync(join(units, "plan.json"), "utf8")) as UnitPlan, app), units);
  return { app, units, env: join(app, "deploy/cloudflare/wrangler.jsonc") };
}

const manifestOf = (units: string) => JSON.parse(readFileSync(join(units, "manifest.json"), "utf8")) as Manifest;
const unitOf = (m: Manifest, name: string) => Object.entries(m.units).find(([, u]) => u.symbol.endsWith(`/${name}`))!;

describe("packed linker over examples/acme", async () => {
  const acme = await sealedAcme();
  const linkTo = (strategy: string, extra: Partial<Parameters<typeof link>[0]> = {}) =>
    link({ app: acme.app, manifestDir: acme.units, environment: acme.env, strategy, out: tmp("forge-linked-"), bundle: false, ...extra });
  const refuses = async (manifest: Manifest, code: LinkError["code"], message: RegExp) => {
    const p = linkTo("per-entry-point", { manifest });
    await expect(p).rejects.toBeInstanceOf(LinkError);
    await expect(p).rejects.toMatchObject({ code });
    await expect(p).rejects.toThrow(message);
  };

  describe("grouping", async () => {
    const per = await linkTo("per-entry-point");
    const one = await linkTo("single");
    const script = (id: string) => per.scripts.find((s) => s.members.includes(id))!;

    it("gives every entry point its own script, except workflow steps and in-process subscriptions", () => {
      const m = manifestOf(acme.units);
      expect(per.scripts).toHaveLength(m.entryPoints.length - 4 - 1 + 1); // 4 steps fold into the workflow, the projection's subscription into the sweep, +1 residual
      expect(script("forge:sweep").members).toContain("projection:CustomerOrderSummary");
      const wf = script("@acme/commerce/_/ProcessOrder");
      expect(wf.members.filter((x) => x.includes("#"))).toHaveLength(4);
      expect(wf.classes.workflows).toEqual([{ className: "ProcessOrderWorkflow", workflow: "@acme/commerce/_/ProcessOrder" }]);
      expect(per.router?.table).toHaveLength(m.entryPoints.filter((e) => e.kind === "http-route").length);
      expect(one.scripts).toHaveLength(1);
      expect(one.router).toBeNull();
    });

    it("puts only a closure's unit modules into its script", () => {
      const m = manifestOf(acme.units);
      const symbols = (id: string) => script(id).modules.map((b) => Object.values(m.units).find((u) => u.implementation["module"] === b)!.symbol).sort();
      expect(symbols("POST /v1/customers")).toEqual([]);
      expect(symbols("POST /v1/orders/{order}/submit")).toEqual(["@acme/commerce/_/SubmitOrder", "@acme/payments/_/AuthorizePayment"]);
      expect(symbols("fulfill-order")).toEqual(["@acme/commerce/_/FulfillOrder"]);
      expect(script("POST /v1/orders/{order}/submit").units.sort()).toEqual(m.entryPoints.find((e) => e.id === "POST /v1/orders/{order}/submit")!.closure);
    });

    it("slices app.json to the declarations a closure reaches", () => {
      const resources = (id: string) => script(id).slice.resources.map((r) => r.split("/").pop());
      expect(script("POST /v1/customers").slice.mode).toBe("slice");
      expect(resources("POST /v1/customers")).toEqual(["Customer"]);
      // A create checks its references: Order points at Customer and Site.
      expect(resources("POST /v1/orders")).toEqual(["Customer", "Order", "Site"]);
      // Restrict-delete reads every resource that points at the deleted one.
      expect(resources("DELETE /v1/customers/{id}")).toEqual(["Customer", "Department", "Order", "Site"]);
      expect(script("POST /v1/customers").slice.bytesSlice).toBeLessThan(script("POST /v1/customers").slice.bytesFull / 10);
      // FORG-33: every runtime surface has an entry point, so nothing falls back to the whole app.
      expect(per.scripts.filter((s) => s.slice.mode === "fallback")).toEqual([]);
      // Changesets may name any operation: every resource, but no function, workflow or read model.
      expect(script("POST /v1/changesets").slice.functions).toEqual([]);
      expect(resources("POST /v1/changesets")).toEqual(["Customer", "Department", "Order", "OrderDocument", "Site", "SitePolicy"]);
      expect(resources("GET /v1/views/pending-orders")).toEqual(["Customer", "Order", "Site"]);
      expect(resources("GET /v1/caches/current-site-policy")).toEqual(["Customer", "Site", "SitePolicy"]);
      // The residual only authenticates and answers 404: an empty model.
      expect(script("forge:residual").slice.mode).toBe("slice");
      expect(script("forge:residual").slice.resources).toEqual([]);
      expect(script("forge:residual").units).toEqual([]);
      // The sweep's closure is the dispatch unit's: every subscriber, not every declaration.
      expect(script("forge:sweep").slice.mode).toBe("slice");
      expect(script("forge:sweep").slice.workflows).toEqual(["@acme/commerce/_/ProcessOrder"]);
      expect(script("forge:sweep").slice.bytesSlice).toBeLessThan(script("forge:sweep").slice.bytesFull);
      // Only contract metadata takes the whole app.json, by design: it publishes the whole contract.
      expect(per.scripts.filter((s) => s.slice.mode === "whole").flatMap((s) => s.members).sort()).toEqual(["GET /forge/discovery", "GET /forge/openapi.json", "GET /forge/workspace.json"]);
    });

    it("hands each script only its declared bindings, and forwards dispatch from sliced scripts to the sweep", () => {
      const names = (id: string) => script(id).capabilities.injected.map((b) => b.name).sort();
      expect(names("POST /v1/customers")).toEqual(["CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS"]);
      expect(names("GET /v1/order-documents/{id}/content")).toEqual(["BLOBS", "CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS"]);
      expect(names("GET /_forge/objects/{token}")).toEqual(["BLOBS", "CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS"]);
      expect(names("forge:sweep")).toEqual(["*/5 * * * *", "CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS", "Q_FULFILL_ORDER", "REALTIME", "WF_PROCESS_ORDER"]);
      expect(script("forge:sweep").dispatch).toBe("local");
      expect(script("POST /v1/customers").dispatch).toBe("forward");
      expect(script("POST /v1/customers").linkerBindings).toEqual([{ type: "service", name: "FORGE_DISPATCH", script: script("forge:sweep").name }]);
      expect(script("forge:sweep").dispatchOwner).toBe(true);
      // The planner declares queue and realtime bindings for SubmitOrder's publish; a sliced script forwards delivery, so they are reported unused.
      expect(script("POST /v1/orders/{order}/submit").capabilities.unused.map((b) => b.name).sort()).toEqual(["Q_FULFILL_ORDER", "REALTIME"]);
      // FORG-34: handles declared for other scripts are withheld, and the runtime gets a stub that answers 403 CapabilityDenied.
      expect(script("POST /v1/customers").withheld).toEqual([
        { type: "r2", name: "BLOBS" },
        { type: "queue-producer", name: "Q_FULFILL_ORDER" },
        { type: "workflow", name: "WF_PROCESS_ORDER" },
      ]);
      expect(script("POST /v1/orders/{order}/process").withheld).toEqual([{ type: "r2", name: "BLOBS" }]);
      // FORG-33: the sweep is sliced to the dispatch unit's closure, which moves no blob bytes, so it
      // holds BLOBS as a refusing stub too; its queue and workflow bindings are its own.
      expect(script("forge:sweep").withheld).toEqual([{ type: "r2", name: "BLOBS" }]);
      // The cancel route declares its workflow binding (FORG-33), so it holds the real handle, not a stub.
      expect(script("POST /v1/workflows/process-order/{id}/cancel").withheld.map((b) => b.name)).not.toContain("WF_PROCESS_ORDER");
      // No group that runs whole-app is left except contract metadata, which reads nothing it withholds.
      expect(per.scripts.filter((s) => s.slice.mode === "fallback")).toEqual([]);
    });

    it("links only the runtime features a slice uses, and every feature where the whole app.json runs (FORG-37)", () => {
      const features = (id: string) => script(id).features;
      const ALL = ["blobs", "changesets", "dispatch", "governance", "imports", "portability", "readModels", "realtime", "schedules", "workflows"];
      expect(features("GET /v1/customers/{id}")).toEqual({ mode: "slice", names: [] });
      expect(features("GET /v1/order-documents/{id}/content")).toEqual({ mode: "slice", names: ["blobs", "governance"] });
      expect(features("@acme/commerce/_/NightlyReconciliation").names).toEqual(["schedules"]);
      expect(features("@acme/commerce/_/ProcessOrder").names).toContain("workflows");
      // Runtime-served routes bring the feature behind them.
      expect(features("POST /v1/changesets").names).toContain("changesets");
      expect(features("POST /v1/imports/stage").names).toEqual(expect.arrayContaining(["changesets", "imports"]));
      expect(features("POST /v1/admin/fence").names).toContain("portability");
      expect(features("POST /v1/admin/inspect").names).toContain("governance");
      expect(features("GET /v1/views/pending-orders").names).toEqual(["readModels"]);
      // The residual answers 404 from an empty model; the sweep is the only script that delivers the outbox.
      expect(features("forge:residual")).toEqual({ mode: "slice", names: [] });
      expect(features("forge:sweep").names).toContain("dispatch");
      expect(per.scripts.filter((s) => s.features.names.includes("dispatch") && s.features.mode === "slice").map((s) => s.members[0])).toEqual(["forge:sweep"]);
      // Contract metadata publishes the whole contract, so it keeps every feature, as does `single`.
      for (const id of ["GET /forge/discovery", "GET /forge/openapi.json", "GET /forge/workspace.json"]) expect(features(id)).toEqual({ mode: "all", names: ALL });
      expect(one.scripts[0]!.features).toEqual({ mode: "all", names: ALL });
    });

    it("finds nothing the planner leaves undeclared", () => {
      // Before FORG-33 the cancel route declared no WF_PROCESS_ORDER although cancelling wakes the native instance.
      expect(script("POST /v1/workflows/process-order/{id}/cancel").capabilities.injected.map((b) => b.name)).toContain("WF_PROCESS_ORDER");
      expect(per.scripts.flatMap((s) => s.capabilities.warnings)).toEqual([]);
    });

    it("falls back to the whole app only for surfaces a manifest leaves uncovered, and says so", async () => {
      const m = manifestOf(acme.units);
      m.uncovered.push({ kind: "view", id: "@acme/commerce/_/Hypothetical", reason: "test" });
      const l = await linkTo("per-entry-point", { manifest: reseal(m) });
      const residual = l.scripts.find((s) => s.members.includes("forge:residual"))!;
      expect(residual.slice.mode).toBe("fallback");
      expect(residual.slice.fallbackReason).toMatch(/uncovered/);
      expect(l.scripts.filter((s) => s.slice.mode === "fallback")).toHaveLength(1);
    });
  });

  describe("fails closed at link time", () => {
    it("refuses a manifest whose content does not match its hash", async () => {
      const m = manifestOf(acme.units);
      m.entryPoints[0]!.id = "tampered";
      await refuses(m, "manifest-hash", /hashes to/);
    });

    it("refuses a missing module blob", async () => {
      const m = manifestOf(acme.units);
      const [, submit] = unitOf(m, "SubmitOrder");
      const blob = submit.implementation["module"] as string;
      delete m.modules[blob];
      await refuses(reseal(m), "missing-module", /SubmitOrder .* runs module sha256:/);
    });

    it("refuses a module whose bytes do not match its digest", async () => {
      const dir = tmp("forge-units-");
      cpSync(acme.units, dir, { recursive: true });
      const m = manifestOf(dir);
      const [, fulfill] = unitOf(m, "FulfillOrder");
      const path = join(dir, m.modules[fulfill.implementation["module"] as string]!.path);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n// edited after sealing\n`);
      expect(() => loadManifest(dir)).toThrow(/module-hash/);
    });

    it("refuses a closure that names a unit the manifest does not carry", async () => {
      const m = manifestOf(acme.units);
      const [hash] = unitOf(m, "AuthorizePayment");
      delete m.units[hash];
      await refuses(reseal(m), "missing-unit", /AuthorizePayment|not in the manifest/);
    });

    it("refuses a unit whose declaration uses a capability the manifest does not grant", async () => {
      const m = manifestOf(acme.units);
      const [, submit] = unitOf(m, "SubmitOrder");
      submit.imports = submit.imports.filter((i) => i.capability !== "resource:@acme/commerce/_/Site#read");
      for (const e of m.entryPoints) e.imports = e.imports.filter((i) => i.capability !== "resource:@acme/commerce/_/Site#read");
      await refuses(reseal(m), "undeclared-capability", /SubmitOrder uses resource:@acme\/commerce\/_\/Site#read/);
    });

    it("refuses an import provided by a unit outside the closure", async () => {
      const m = manifestOf(acme.units);
      const [, fulfill] = unitOf(m, "FulfillOrder");
      const [rebuild] = unitOf(m, "RebuildOrderSummary");
      fulfill.imports.push({ capability: "function:@acme/commerce/_/RebuildOrderSummary", provider: { kind: "unit", unit: rebuild } });
      await refuses(reseal(m), "unprovided-capability", /FulfillOrder imports function:@acme\/commerce\/_\/RebuildOrderSummary from a unit outside the closure/);
    });

    it("refuses a blob route that does not declare its bucket", async () => {
      const m = manifestOf(acme.units);
      const route = m.entryPoints.find((e) => e.id === "GET /v1/order-documents/{id}/content")!;
      route.bindings = route.bindings.filter((b) => b.name !== "BLOBS");
      await refuses(reseal(m), "undeclared-binding", /OrderDocument.download moves blob bytes .* needs r2 BLOBS/);
    });

    it("refuses a workflow whose driver binding is undeclared", async () => {
      const m = manifestOf(acme.units);
      for (const e of m.entryPoints) e.bindings = e.bindings.filter((b) => b.name !== "WF_PROCESS_ORDER");
      await refuses(reseal(m), "undeclared-binding", /ProcessOrder is driven by Cloudflare Workflows .* needs workflow WF_PROCESS_ORDER/);
    });

    it("refuses a dispatch owner whose slice would drop a subscriber's deliveries", async () => {
      const m = manifestOf(acme.units);
      const [, dispatch] = unitOf(m, "dispatch");
      dispatch.imports = dispatch.imports.filter((i) => i.capability !== "deliver:fulfill-order");
      for (const e of m.entryPoints) e.imports = e.imports.filter((i) => i.capability !== "deliver:fulfill-order");
      await refuses(reseal(m), "slice", /dispatch owner's slice lacks subscribers the full app has: subscription fulfill-order/);
    });

    it("refuses a module that reaches authority outside its capability handles", async () => {
      const m = manifestOf(acme.units);
      const [, fulfill] = unitOf(m, "FulfillOrder");
      fulfill.findings.push({ rule: "raw-env", match: "env.DB", source: "impl/fulfill-order.ts" });
      await refuses(reseal(m), "undeclared-capability", /FulfillOrder reaches authority outside its capability handles: raw-env `env.DB`/);
    });
  });

  it("links byte-identically twice, and serves acme in workerd with routing and bindings enforced per script", async () => {
    const [outA, outB] = [tmp("forge-linked-a-"), tmp("forge-linked-b-")];
    const a = await link({ app: acme.app, manifestDir: acme.units, environment: acme.env, strategy: "per-entry-point", out: outA });
    const b = await link({ app: acme.app, manifestDir: acme.units, environment: acme.env, strategy: "per-entry-point", out: outB });
    expect(readFileSync(join(outB, "link.json"), "utf8")).toBe(readFileSync(join(outA, "link.json"), "utf8"));
    expect(b.scripts.map((s) => s.scriptHash)).toEqual(a.scripts.map((s) => s.scriptHash));
    expect(a.live).toBe(manifestOf(acme.units).manifestHash);

    const env = readJsonc(acme.env) as Environment;
    const served = await serve(scriptsOf(a as Link, outA), env, { secret: "t3-test-secret", migrations: join(acme.app, "migrations/d1") });
    try {
      const h = { "x-forge-tenant": "t-link", "x-forge-actor": "tester", "content-type": "application/json" };
      const created = await fetch(`${served.url}/v1/customers`, { method: "POST", headers: h, body: JSON.stringify({ code: "ACME-1", name: "Acme" }) });
      expect(created.status).toBe(201);
      const id = ((await created.json()) as { id: string }).id;
      expect((await fetch(`${served.url}/v1/customers/${id}`, { headers: h })).status).toBe(200);
      // Called directly, a script refuses a route that belongs to another script.
      const createScript = a.scripts.find((s) => s.members.includes("POST /v1/customers"))!;
      const direct = await (await served.mf.getWorker(createScript.name)).fetch(`http://x/v1/customers/${id}`, { headers: h });
      expect(direct.status).toBe(404);
      expect(((await direct.json()) as { code: string }).code).toBe("NotRouted");
      // The residual refuses manifest routes, and answers what no entry point claims as the runtime does.
      const residual = a.scripts.find((s) => s.members.includes("forge:residual"))!;
      expect((await (await served.mf.getWorker(residual.name)).fetch("http://x/v1/customers", { headers: h })).status).toBe(404);
      const unknown = await fetch(`${served.url}/v1/nothing-here`, { headers: h });
      expect([unknown.status, ((await unknown.json()) as { code: string }).code]).toEqual([404, "NotFound"]);
      expect((await fetch(`${served.url}/v1/nothing-here`)).status).toBe(401);
      // A method no entry point serves on a known path: the path's owner answers 405, as the whole app does.
      const wrong = await fetch(`${served.url}/v1/customers`, { method: "DELETE", headers: h });
      expect([wrong.status, ((await wrong.json()) as { code: string }).code]).toEqual([405, "MethodNotAllowed"]);
      // Runtime surfaces T3 left to the residual are entry points with their own scripts now.
      expect((await fetch(`${served.url}/forge/discovery`, { headers: h })).status).toBe(200);
      expect((await fetch(`${served.url}/v1/views/pending-orders?customer=${id}`, { headers: h })).status).toBe(200);
      expect((await fetch(`${served.url}/v1/schedules/nightly-reconciliation`, { headers: h })).status).toBe(200);
      // CORS reaches the runtime now that FORGE_CORS is a host binding.
      const preflight = await fetch(`${served.url}/v1/customers`, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
      expect([preflight.status, preflight.headers.get("access-control-allow-origin")]).toEqual([204, "http://localhost:5173"]);
      // Each script's env holds exactly its declared bindings (plus the dispatch service binding).
      expect(Object.keys(await served.mf.getBindings(createScript.name)).sort()).toEqual(["CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS", "FORGE_DISPATCH"]);
    } finally {
      await served.close();
    }
  });
});
