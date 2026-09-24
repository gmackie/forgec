/** #17: the same collection vectors cross the live HTTP boundary in three SDKs. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MemoryStorage, devHeaderAuth, type AppBundle } from "@forgegraph/runtime";
import { createNodeHost, type NodeHost } from "@forgegraph/runtime/node";
import { httpCallable } from "../src/rpc.js";

const fixture = resolve(import.meta.dirname, "fixtures/collection-steps.json");
const steps = JSON.parse(readFileSync(fixture, "utf8")) as { step: string; operation: string; input: Record<string, unknown> }[];
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../conformance/fixtures/collections/app.json"), "utf8")) as AppBundle;
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["id", "createdAt", "updatedAt", "requestId"].includes(key)).map(([key, v]) => [key, normalize(v)]));
  return value;
}
let host: NodeHost;
let base: string;
let reference: { step: string; kind: string; value?: any; problem?: any }[];
beforeAll(async () => {
  host = createNodeHost({ auth: devHeaderAuth(), bundle, store: new MemoryStorage(), cursorSecret: "collection-sdk", sweepIntervalMs: 0, telemetryFormat: "silent" });
  base = (await host.listen(0)).url;
  const client = httpCallable({ baseUrl: base, credential: { kind: "dev-header", tenant: "collections-ts", actor: "sdk" } });
  const seen: Record<string, any> = {};
  const bind = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$")) { const [step, field] = v.slice(1).split("."); return seen[step!][field!]; }
    if (Array.isArray(v)) return v.map(bind);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bind(x)]));
    return v;
  };
  reference = [];
  for (const { step, operation, input } of steps) {
    const id = Object.values((bundle.openapi as { paths: Record<string, any> }).paths).flatMap(methods => Object.values(methods) as any[]).find(op => op.operationId?.endsWith(`/_/${operation}`))?.operationId;
    expect(id, operation).toBeDefined();
    const out = await client.invoke(id, bind(input));
    if (out.kind === "ok") { seen[step] = out.value; reference.push({ step, kind: "ok", value: normalize(out.value) }); }
    else if (out.kind === "error") reference.push({ step, kind: "error", problem: { code: out.problem.code, status: out.problem.status, fields: (out.problem.fields ?? []).map(f => f.path).sort() } });
    else throw Error(`Unexpected transport failure: ${out.reason}`);
  }
}, 60_000);
afterAll(async () => { await host?.stop(); });
it("preserves exact integers, nested list order, canonical sets, map keys and partial updates", () => {
  const by = Object.fromEntries(reference.map(r => [r.step, r]));
  expect(by.create!.value).toMatchObject({ objectives: [{ title: "Win 🧭", score: 9007199254740991 }], tags: ["a", "z"], grid: [[3, 1], [2]], metadata: JSON.parse('{"a":"first","z":"last","__proto__":"ordinary key"}') });
  expect(by.get!.value).toEqual(by.create!.value);
  expect(by["get-updated"]!.value).toEqual(by.patch!.value);
  expect(by.patch!.value).toMatchObject({ version: 2, tags: ["a", "b"], grid: [[4], []], objectives: by.create!.value.objectives, metadata: by.create!.value.metadata });
  expect(by.mailing!.value.recipients).toEqual(["a@example.com", "z@example.com"]);
  for (const name of ["duplicate-set", "bounds", "nested-type", "unknown-field", "required-element", "map-key", "invalid-email"]) expect(by[name]).toMatchObject({ kind: "error", problem: { code: "ValidationFailed", status: 422 } });
});
const available = (command: string) => { try { execFileSync(command, [command === "go" ? "version" : "--version"], { stdio: "ignore" }); return true; } catch { return false; } };
const run = promisify(execFile);
it.skipIf(!available("python3"))("Python matches every collection result and validation outcome", async () => {
  const { stdout } = await run("python3", [resolve(import.meta.dirname, "../sdk-python/conformance.py"), base, "collections-py", fixture], { timeout: 60_000 });
  expect(normalize(JSON.parse(stdout))).toEqual(reference);
}, 70_000);
it.skipIf(!available("go"))("Go matches every collection result and validation outcome", async () => {
  const { stdout } = await run("go", ["run", "./cmd/conformance", base, "collections-go", fixture], { cwd: resolve(import.meta.dirname, "../sdk-go"), timeout: 120_000 });
  expect(normalize(JSON.parse(stdout))).toEqual(reference);
}, 130_000);
