// Linker C at link time: the policy resolves to entry points, the packed tier is linker A's output,
// and the router and tier host carry what the policy decided. No workerd.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { link, readJsonc, type Link } from "@forgegraph/linker-packed";
import type { TieredLink } from "../src/link.ts";
import { glob, resolvePolicy, TieredLinkError, type DynamicPolicy } from "../src/policy.ts";
import { acme, acmeManifest, envPath, linkAcme, policy, prepare, scriptDigests, unitsOut } from "./fixtures.ts";

const P = (entryPoints: string[], closureHashes: string[] = []): DynamicPolicy => ({ version: "tiered-policy/1", dynamic: { entryPoints, closureHashes } });
const refusal = (p: DynamicPolicy) => {
  try {
    resolvePolicy(acmeManifest(), p);
  } catch (e) {
    expect(e).toBeInstanceOf(TieredLinkError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("dynamic policy", () => {
  beforeAll(() => prepare(), 600_000);

  it("matches entry point ids exactly or by glob, `*` within a segment and `**` across", () => {
    expect(glob("POST /v1/orders/*").test("POST /v1/orders/{id}")).toBe(true);
    expect(glob("POST /v1/orders/*").test("POST /v1/orders/{id}/actions/approve")).toBe(false);
    expect(glob("POST /v1/orders/**").test("POST /v1/orders/{id}/actions/approve")).toBe(true);
    expect(glob("POST /v1/orders").test("POST /v1/orders/{id}")).toBe(false);
  });

  it("resolves acme's policy: the order write path and the ProcessOrder workflow, whose steps follow it", () => {
    const r = resolvePolicy(acmeManifest(), policy());
    expect(r.entryPoints.map((e) => e.id)).toEqual([
      "@acme/commerce/_/ProcessOrder",
      "@acme/commerce/_/ProcessOrder#approve",
      "@acme/commerce/_/ProcessOrder#short",
      "@acme/commerce/_/ProcessOrder#submit",
      "@acme/commerce/_/ProcessOrder#summary",
      "DELETE /v1/orders/{id}",
      "PATCH /v1/orders/{id}",
      "POST /v1/orders",
      "POST /v1/orders/{id}/actions/approve",
      "POST /v1/orders/{id}/actions/cancel",
      "POST /v1/orders/{id}/actions/complete",
      "POST /v1/orders/{order}/process",
      "POST /v1/orders/{order}/submit",
      "POST /v1/workflows/process-order/signals/{message}",
    ]);
    expect(r.entryPoints.find((e) => e.id === "@acme/commerce/_/ProcessOrder#submit")!.matchedBy).toBe("workflow:@acme/commerce/_/ProcessOrder");
  });

  it("marks by closure hash: every entry point whose closure had that hash at link time", () => {
    const m = acmeManifest();
    const submit = m.entryPoints.find((e) => e.id === "POST /v1/orders/{order}/submit")!;
    const r = resolvePolicy(m, P([], [submit.closureHash]));
    // ProcessOrder#submit has the same closure; a step follows its workflow, not a hash.
    expect(m.entryPoints.filter((e) => e.closureHash === submit.closureHash).map((e) => e.id).sort()).toEqual(["@acme/commerce/_/ProcessOrder#submit", submit.id]);
    expect(r.entryPoints.map((e) => [e.id, e.matchedBy])).toEqual([[submit.id, submit.closureHash]]);
  });

  it("refuses a selector that matches nothing, and entry points the dynamic tier cannot serve", () => {
    expect(refusal(P(["POST /v1/nope"]))).toMatch(/matches no entry point/);
    expect(refusal(P([], ["sha256:00"]))).toMatch(/is no entry point's closure/);
    // The sweep is the one dispatch owner and a cron: it stays packed.
    expect(refusal(P(["forge:sweep"]))).toMatch(/forge:sweep is a cron/);
    expect(refusal(P(["fulfill-order"]))).toMatch(/fulfill-order is a queue-consumer/);
    expect(refusal(P(["ForgeRealtime"]))).toMatch(/durable-object/);
    expect(refusal(P(["GET /v1/live/orders"]))).toMatch(/realtime upgrade route/);
    expect(refusal(P(["GET /forge/openapi.json"]))).toMatch(/has no closure/);
    expect(refusal(P(["@acme/commerce/_/ProcessOrder#submit"]))).toMatch(/runs in its workflow's tier/);
  });
});

describe("linking acme tiered", () => {
  let out = "";
  let t: TieredLink;
  let plain: Link;
  let plainOut = "";
  beforeAll(async () => {
    prepare();
    out = mkdtempSync(join(tmpdir(), "forg43-link-"));
    t = await linkAcme(out);
    plainOut = mkdtempSync(join(tmpdir(), "forg43-plain-"));
    plain = await link({ app: acme, manifestDir: unitsOut, environment: envPath, strategy: "per-entry-point", out: plainOut });
  }, 600_000);

  it("packs every entry point as linker A does; only the script holding the dynamic workflow's class differs (it serves the advance step)", () => {
    expect(t.packed.scripts.map((s) => s.name)).toEqual(plain.scripts.map((s) => s.name));
    const differ = t.packed.scripts.filter((s) => s.scriptHash !== plain.scripts.find((p) => p.name === s.name)!.scriptHash).map((s) => s.name);
    expect(differ).toEqual(t.host.workflows.map((w) => w.packedScript));
    const packed = JSON.parse(readFileSync(join(out, "packed/link.json"), "utf8")) as Link;
    expect(packed.scripts.find((s) => s.name === differ[0])!.classes.workflows.map((w) => w.className)).toEqual(["ProcessOrderWorkflow"]);
    expect(readFileSync(join(out, "packed", differ[0]!, "entry.mjs"), "utf8")).toContain('"advance":true');
  });

  it("gives every dynamic entry point a packed fallback, and routes only those dynamically", () => {
    expect(t.dynamic.every((d) => t.packed.scripts.some((s) => s.name === d.packedScript))).toBe(true);
    const dynamicRoutes = t.router.table.filter((r) => r.dynamic).map((r) => `${r.method} ${r.path}`).sort();
    expect(dynamicRoutes).toEqual(t.dynamic.filter((d) => d.kind === "http-route").map((d) => d.id).sort());
    expect(t.router.table.length).toBe(plain.router!.table.length);
    expect(t.deploy).toEqual([t.router.name, t.host.name, ...plain.scripts.map((s) => s.name)]);
    expect(t.deploy).not.toContain(plain.router!.name);
  });

  it("has exactly one dispatch owner across both tiers: linker A's sweep script", () => {
    const owners = t.packed.scripts.filter((s) => (JSON.parse(readFileSync(join(out, "packed/link.json"), "utf8")) as Link).scripts.find((x) => x.name === s.name)!.dispatchOwner);
    expect(owners.map((s) => s.name)).toEqual([t.packed.dispatchOwner]);
    expect(t.packed.dispatchOwner).toMatch(/forge-sweep/);
    expect(t.host.services["FORGE_DISPATCH"]).toBe(t.packed.dispatchOwner);
    const host = readJsonc(join(out, t.host.name, "wrangler.jsonc")) as Record<string, any>;
    expect(host["triggers"]).toBeUndefined(); // no cron: the owner runs every sweep
    expect(host["queues"]?.consumers).toBeUndefined();
  });

  it("deploys the tier host with only what its dynamic closures declare, and moves the workflow class to it", () => {
    expect(t.host.bindings).toEqual(["CURSOR_SECRET", "DB", "FORGE_AUTH", "FORGE_CORS", "Q_FULFILL_ORDER", "WF_PROCESS_ORDER"]);
    expect(t.host.bindings).not.toContain("BLOBS");
    const host = readJsonc(join(out, t.host.name, "wrangler.jsonc")) as Record<string, any>;
    expect(host["worker_loaders"]).toEqual([{ binding: "LOADER" }]);
    expect(host["workflows"]).toEqual([{ name: "forge-acme-commerce-process-order", binding: "WF_PROCESS_ORDER", class_name: "ProcessOrderWorkflow" }]);
    expect(readFileSync(join(out, t.host.name, "entry.mjs"), "utf8")).toContain("export class ProcessOrderWorkflow extends host.workflow(WorkflowEntrypoint");
    // Every packed config naming the workflow binds the tier host's class.
    const wf = t.host.workflows[0]!;
    const cfg = readJsonc(join(out, "packed", wf.packedScript, "wrangler.tiered.jsonc")) as Record<string, any>;
    expect(cfg["workflows"]).toEqual([{ name: "forge-acme-commerce-process-order", binding: "WF_PROCESS_ORDER", class_name: "ProcessOrderWorkflow", script_name: t.host.name }]);
  });

  it("links byte-identically twice", async () => {
    const again = mkdtempSync(join(tmpdir(), "forg43-again-"));
    const t2 = await linkAcme(again);
    expect(readFileSync(join(again, "tiered.json"), "utf8")).toBe(readFileSync(join(out, "tiered.json"), "utf8"));
    expect(scriptDigests(again)).toEqual(scriptDigests(out));
    expect(t2.router.scriptHash).toBe(t.router.scriptHash);
  });
});
