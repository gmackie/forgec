// FORG-42: strategy `per-entry-point-shared`. The link: which groups use the shared runtime Worker,
// what a shared script still carries, and that the runtime Worker holds no app code and no bindings.
// The host: a shared script and the runtime Worker wired together in Node (no workerd; RPC stubs are
// plain objects here), showing that narrowing stays per script: the runtime reaches only what the
// script hands it, and a binding withheld from the script answers 403 CapabilityDenied as in host.ts.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { Model, type AppBundle } from "@forgegraph/runtime";
import { requiredFeatures } from "@forgegraph/runtime/features";
import { seal, writeSealed, type UnitPlan } from "@forgegraph/units";
import { link, readJsonc } from "../src/index.ts";
import type { HostConfig } from "../src/host.ts";
import { sharedRuntime } from "../src/shared/runtime.ts";
import { packedShared } from "../src/shared/script.ts";
import { sliceHashOf } from "../src/shared/link.ts";

const root = resolve(import.meta.dirname, "../../..");
const forgec = join(root, "target/debug/forgec");
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

async function sealedAcme() {
  const dir = tmp("forge-shared-");
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

describe("per-entry-point-shared over examples/acme", async () => {
  const acme = await sealedAcme();
  const out = tmp("forge-shared-linked-");
  const linkTo = (strategy: string) => link({ app: acme.app, manifestDir: acme.units, environment: acme.env, strategy, out: join(out, strategy) });
  const [per, shared] = [await linkTo("per-entry-point"), await linkTo("per-entry-point-shared")];
  const script = (id: string) => shared.scripts.find((s) => s.members.includes(id))!;

  it("groups and narrows exactly as per-entry-point", () => {
    const project = (l: typeof per) => l.scripts.map((s) => ({ name: s.name, members: s.members, routes: s.routes, injected: s.capabilities.injected, withheld: s.withheld, features: s.features, slice: s.slice.bytesSlice }));
    expect(project(shared)).toEqual(project(per));
    expect(shared.router?.table).toEqual(per.router?.table);
  });

  it("keeps the engine in process only where the platform or dispatch needs it", () => {
    const inProcess = shared.scripts.filter((s) => s.runtime?.mode === "in-process").map((s) => [s.members[0], s.runtime!.reason]);
    expect(inProcess.sort()).toEqual([
      ["@acme/commerce/_/ProcessOrder", "workflow class"],
      ["ForgeRealtime", "realtime object"],
      ["GET /v1/live/orders", "websocket upgrade"],
      ["forge:sweep", "dispatch owner"],
    ]);
    expect(shared.scripts.filter((s) => s.runtime?.mode === "shared")).toHaveLength(shared.scripts.length - 4);
    expect(per.scripts.every((s) => s.runtime === undefined) && per.runtime === undefined).toBe(true);
  });

  it("a shared script carries routing, units and its slice, and no engine; with no js unit, no Effect either", () => {
    const read = script("GET /v1/customers/{id}");
    expect(read.composition!["runtime"] ?? 0).toBe(0);
    expect(read.composition!["effect"] ?? 0).toBe(0);
    expect(read.bytes!.raw).toBeLessThan(read.composition!["app.json"]! + 8_000);
    const submit = script("POST /v1/orders/{order}/submit");
    // Its units import Effect themselves, so Effect comes with them; the engine does not.
    expect(submit.composition!["runtime"]!).toBeLessThan(8_000);
    expect(submit.linkerBindings.map((b) => b.name).sort()).toEqual(["FORGE_DISPATCH", "FORGE_RUNTIME"]);
  });

  it("emits one runtime Worker with no bindings and no app code; every shared script binds it", () => {
    const rt = shared.runtime!;
    const cfg = readJsonc(join(out, "per-entry-point-shared", rt.name, "wrangler.jsonc")) as Record<string, unknown>;
    expect(Object.keys(cfg).sort()).toEqual(["compatibility_date", "main", "name", "no_bundle", "workers_dev"]);
    const entry = readFileSync(join(out, "per-entry-point-shared", rt.name, "worker.js"), "utf8");
    expect(entry).not.toContain("@acme/commerce");
    expect(rt.bytes!.raw).toBeGreaterThan(200_000);
    expect(Object.keys(rt.composition!).sort()).toEqual(["effect", "entry", "host", "runtime"]);
    const viaRuntime = shared.scripts.filter((s) => s.linkerBindings.some((b) => b.name === "FORGE_RUNTIME" && b.script === rt.name));
    expect(viaRuntime).toHaveLength(shared.scripts.length - 4);
  });
});

// --- The host, in Node -------------------------------------------------------------------------

const bundle = JSON.parse(readFileSync(join(root, "conformance/fixtures/acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(join(root, "packages/runtime/test/d1-harness/migrations/0001_all.sql"), "utf8");

/** A D1 binding over node:sqlite (what the script holds; the runtime only sees it through the script). */
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => db.prepare(sql).get(...(params as SQLInputValue[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as SQLInputValue[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes) } }),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (ss: Array<ReturnType<typeof stmt>>) => {
      db.exec("BEGIN");
      try {
        const out = ss.map((s) => ({ results: [], meta: { changes: Number(db.prepare(s.sql).run(...(s.params as SQLInputValue[])).changes) } }));
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const emptyBucket = { head: async () => null, get: async () => null, put: async () => ({ etag: "e" }), delete: async () => undefined };
class Rpc {}
class Entrypoint {}
const Runtime = sharedRuntime(Entrypoint, Rpc) as unknown as new () => { serve: (...a: unknown[]) => Promise<{ response: Response; dispatch: string[] }> };

const config = (bindings: string[], withheld: HostConfig["withheld"]): HostConfig => ({
  script: "forge-acme-test-finalize",
  routes: null,
  deny: [],
  bindings,
  withheld,
  dispatch: "forward",
  dispatchOwner: false,
  sweeps: { outbox: false, schedules: false, workflows: false },
});
const TYPES: Record<string, string> = { DB: "d1", BLOBS: "r2", CURSOR_SECRET: "secret", FORGE_AUTH: "var" };

function sharedHost(cfg: HostConfig) {
  const features = requiredFeatures(new Model(bundle));
  const meta = { script: cfg.script, sliceHash: sliceHashOf(JSON.stringify(bundle)), features, objects: true, bindings: cfg.bindings.map((name) => ({ name, type: TYPES[name]! })), withheld: cfg.withheld, sweeps: cfg.sweeps };
  return packedShared(Rpc, bundle, null, cfg, meta);
}

async function finalizeWithoutBytes(cfg: HostConfig) {
  const runtime = new Runtime();
  const calls: string[] = [];
  const spy = new Proxy(runtime, { get: (t, k) => (k === "serve" ? (...a: unknown[]) => (calls.push("serve"), t.serve(...a)) : Reflect.get(t, k)) });
  const env: Record<string, unknown> = { DB: d1(), BLOBS: emptyBucket, CURSOR_SECRET: "t", FORGE_AUTH: "dev-headers", FORGE_RUNTIME: spy };
  const { worker } = sharedHost(cfg);
  const h = { "content-type": "application/json", "x-forge-tenant": "t1", "x-forge-actor": "a" };
  const call = async (path: string, body: unknown, version?: number) => {
    const headers = version === undefined ? h : { ...h, "if-match": `"${version}"` };
    const res = await worker.fetch(new Request(`https://forge.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env, { waitUntil: (p) => void p.catch(() => undefined) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const c = await call("/v1/customers", { code: "BLOB", name: "B" });
  expect(c.status).toBe(201);
  const s = await call("/v1/sites", { customer: c.json["id"], code: "hq", name: "HQ", timezone: "UTC" });
  const o = await call("/v1/orders", { customer: c.json["id"], site: s.json["id"], subtotal: "1.00", tax: "0.00", requestedOn: "2026-09-20" });
  const doc = await call("/v1/order-documents", { order: o.json["id"], kind: "quote", label: "Q1" });
  expect(doc.status).toBe(201);
  const begin = await call(`/v1/order-documents/${String(doc.json["id"])}/upload`, { expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 }, 1);
  expect(begin.status).toBe(200);
  const r = await call(`/v1/order-documents/${String(doc.json["id"])}/finalize`, { expectedVersion: 2 }, 2);
  return { ...r, calls: calls.length };
}

describe("shared host: narrowing stays per script (FORG-34 through the runtime Worker)", () => {
  it("a declared bucket is used through the script: finalize with no bytes is ValidationFailed", async () => {
    const r = await finalizeWithoutBytes(config(["DB", "BLOBS", "CURSOR_SECRET", "FORGE_AUTH"], []));
    expect(r.status).toBe(422);
    expect(r.json["code"]).toBe("ValidationFailed");
    expect(r.calls).toBe(6);
  });

  it("a bucket withheld from the script is refused with 403 CapabilityDenied by the runtime Worker", async () => {
    const r = await finalizeWithoutBytes(config(["DB", "CURSOR_SECRET", "FORGE_AUTH"], [{ type: "r2", name: "BLOBS" }]));
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: "CapabilityDenied", retryable: false, capability: "binding:r2:BLOBS", entryPoint: "forge-acme-test-finalize" });
  });

  it("the script's capability object reaches only the script's own bindings, by name and type", async () => {
    const runtime = new Runtime();
    let caps: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    const env: Record<string, unknown> = { DB: d1(), BLOBS: emptyBucket, OTHER: d1(), CURSOR_SECRET: "t", FORGE_AUTH: "dev-headers", FORGE_RUNTIME: { serve: (_r: unknown, c: typeof caps, ...rest: unknown[]) => ((caps = c), runtime.serve(_r, c, ...rest)) } };
    const { worker } = sharedHost(config(["DB", "CURSOR_SECRET", "FORGE_AUTH"], [{ type: "r2", name: "BLOBS" }]));
    await worker.fetch(new Request("https://forge.test/v1/customers/x", { headers: { "x-forge-tenant": "t1", "x-forge-actor": "a" } }), env, { waitUntil: () => undefined });
    await expect(caps["d1"]!("DB", "first", "SELECT 1 AS x", [])).resolves.toEqual({ x: 1 });
    await expect(caps["d1"]!("OTHER", "first", "SELECT 1 AS x", [])).rejects.toThrow(/not linked with d1 OTHER/);
    await expect(caps["r2"]!("BLOBS", "head", "k")).rejects.toThrow(/not linked with r2 BLOBS/);
    await expect(caps["d1"]!("BLOBS", "first", "SELECT 1", [])).rejects.toThrow(/not linked/);
  });

  it("refuses a slice that does not match the hash the script was linked with", async () => {
    const runtime = new Runtime();
    const meta = { script: "s", sliceHash: "0".repeat(64), features: [], objects: false, bindings: [], withheld: [], sweeps: { outbox: false, schedules: false, workflows: false }, functions: [], externals: [] };
    await expect(runtime.serve(new Request("https://forge.test/"), { slice: async () => bundle }, meta, {})).rejects.toThrow(/does not match its hash/);
  });
});
