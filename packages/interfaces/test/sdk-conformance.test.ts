/**
 * FORGE-055/056 / PAR-123: plain TypeScript, Python and Go clients exercise
 * the same generated surface (decimals, null-vs-absent PATCH, enums, typed
 * errors, jobs) and observe the same canonical values. None of them needs
 * Effect or a database. Python and Go run as subprocesses against a live
 * Node host; a missing toolchain skips that language and says so.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage, type AppBundle } from "@forge/runtime";
import { createNodeHost, type NodeHost } from "@forge/runtime/node";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { httpCallable, type Outcome } from "../src/rpc.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const here = resolve(import.meta.dirname, "..");

/** The shared scenario (kept in lockstep with sdk-python/conformance.py and sdk-go/cmd/conformance). */
const STEPS: [string, string, Record<string, unknown>][] = [
  ["create", "Customer.create", { code: "SDK", name: "Sdk", tier: "gold" }],
  ["get", "Customer.get", { id: "$create.id" }],
  ["enum", "Customer.create", { code: "SDK2", name: "X", tier: "platinum" }],
  ["patch-null", "Customer.update", { id: "$create.id", expectedVersion: 1, patch: { email: null } }],
  ["patch-absent", "Customer.update", { id: "$create.id", expectedVersion: 2, patch: { tier: "standard" } }],
  ["stale", "Customer.update", { id: "$create.id", expectedVersion: 1, patch: { name: "Stale" } }],
  ["site", "Site.create", { customer: "$create.id", code: "S1", name: "Site 1", timezone: "UTC" }],
  ["order", "Order.create", { customer: "$create.id", site: "$site.id", subtotal: "10.10", tax: "0.20", requestedOn: "2026-09-20" }],
  ["transition", "Order.status.approve", { id: "$order.id", expectedVersion: 1, input: {} }],
  ["job", "ProcessOrder.start", { order: "$order.id", expectedVersion: 1 }],
  ["page", "Customer.list.byTier", { params: { tier: "standard" }, limit: 5 }],
  ["missing", "Customer.get", { id: "nope" }],
];

const VOLATILE = new Set(["createdAt", "updatedAt", "requestId"]);
const ID = /^[a-z]{2,4}_[0-9a-z]{20,32}$/;
/** Ids are generated per deployment/tenant: compare their shape, not their value. */
function normalize(v: unknown): unknown {
  if (typeof v === "string" && ID.test(v)) return "<id>";
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) if (!VOLATILE.has(k)) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function available(cmd: string, args: string[]): boolean {
  try { execFileSync(cmd, args, { stdio: "ignore" }); return true; } catch { return false; }
}
const hasPython = available("python3", ["--version"]);
const hasGo = available("go", ["version"]);

describe("PAR-123: cross-language wire conformance", () => {
  let host: NodeHost;
  let base: string;
  let reference: unknown[];
  beforeAll(async () => {
    host = createNodeHost({ bundle, store: new MemoryStorage(), functions, externals, cursorSecret: "sdk-test", sweepIntervalMs: 0, telemetryFormat: "silent" });
    base = (await host.listen(0)).url;
    const client = httpCallable({ baseUrl: base, credential: { kind: "dev-header", tenant: "sdk-ts", actor: "sdk-ts" } });
    reference = [];
    const seen: Record<string, Record<string, unknown>> = {};
    // "$step.field" placeholders chain ids from earlier steps (the same convention as the other runners)
    const bind = (v: unknown): unknown => typeof v === "string" && v.startsWith("$") ? seen[v.slice(1).split(".")[0]!]?.[v.split(".")[1]!] : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, bind(x)])) : v;
    for (const [step, op, input] of STEPS) {
      const out: Outcome = await client.invoke(`@acme/commerce/_/${op}`, bind(input));
      if (out.kind === "ok") {
        let value = out.value as Record<string, unknown>;
        seen[step] = value;
        if (step === "job") value = { workflow: value["workflow"], status: value["status"], version: value["version"] };
        reference.push({ step, kind: "ok", value });
      } else if (out.kind === "error") reference.push({ step, kind: "error", problem: { code: out.problem.code, status: out.problem.status, fields: (out.problem.fields ?? []).map((f) => f.path).sort() } });
      else reference.push({ step, kind: "invocationFailed", reason: out.reason });
    }
    reference = normalize(reference) as unknown[];
  }, 60_000);
  afterAll(async () => { await host?.stop(); });

  it("the TypeScript reference observes the canonical values the contract promises", () => {
    type Step = { step: string; kind: string; value?: Record<string, unknown>; problem?: { code: string; status: number; fields: string[] } };
    const by = Object.fromEntries((reference as Step[]).map((r) => [r.step, r]));
    expect(by["create"]!.value).toMatchObject({ id: "<id>", version: 1, tier: "gold", email: null });
    expect(by["enum"]!.problem).toEqual({ code: "ValidationFailed", status: 422, fields: ["tier"] });
    expect(by["patch-null"]!.value).toMatchObject({ version: 2, email: null });
    expect(by["patch-absent"]!.value).toMatchObject({ version: 3, name: "Sdk", tier: "standard" });
    expect(by["stale"]!.problem).toMatchObject({ code: "VersionConflict", status: 412 });
    expect(by["order"]!.value).toMatchObject({ subtotal: "10.10", tax: "0.20", total: "10.30", status: "Draft" });
    expect(by["transition"]!.problem).toMatchObject({ code: "InvalidTransition", status: 409 });
    expect(by["job"]!.value).toMatchObject({ workflow: "@acme/commerce/_/ProcessOrder", version: 1 });
    expect(["running", "waiting", "sleeping", "completed"]).toContain(by["job"]!.value!["status"]);
    expect(by["page"]!.value).toMatchObject({ limit: 5, next: null });
    expect((by["page"]!.value!["items"] as unknown[]).length).toBe(1);
    expect(by["missing"]!.problem).toMatchObject({ code: "NotFound", status: 404 });
  });

  // Subprocesses must run asynchronously: the host they talk to lives on this event loop.
  const run = promisify(execFile);

  it.skipIf(!hasPython)("the Python client (stdlib only, Decimal for money) matches the reference", async () => {
    const { stdout } = await run("python3", [resolve(here, "sdk-python", "conformance.py"), base, "sdk-py"], { encoding: "utf8", timeout: 60_000 });
    expect(normalize(JSON.parse(stdout))).toEqual(reference);
  }, 70_000);

  it.skipIf(!hasGo)("the Go client (json.Number, strings for money) matches the reference", async () => {
    const { stdout } = await run("go", ["run", "./cmd/conformance", base, "sdk-go"], { cwd: resolve(here, "sdk-go"), encoding: "utf8", timeout: 120_000, env: { ...process.env, GOFLAGS: "-mod=mod" } });
    expect(normalize(JSON.parse(stdout))).toEqual(reference);
  }, 130_000);

  it("no client depends on Effect or a database driver", () => {
    const py = readFileSync(resolve(here, "sdk-python", "forge_api.py"), "utf8");
    const go = readFileSync(resolve(here, "sdk-go", "forge", "client.go"), "utf8");
    const ts = readFileSync(resolve(here, "src", "rpc.ts"), "utf8");
    for (const src of [py, go]) expect(src).not.toMatch(/\b(effect|pg|dynamodb|sqlite|drizzle)\b/i);
    // the TypeScript module imports Effect only for the *local* binding; the HTTP binding is plain fetch
    expect(ts).toMatch(/export function httpCallable/);
    expect(ts).not.toMatch(/from "pg"|dynamodb/);
  });
});
