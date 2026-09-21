/** FORGE-084 / PAR-167, PAR-168: generated dashboards and SLO rules. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forge/runtime";
import { dashboard, errorBudget, toGrafana } from "../src/dashboards.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("dashboard projection", () => {
  it("PAR-168: panels carry the plan's exact buckets and SLO targets; an unsupported provider metric is missing, never zero", () => {
    const d = dashboard(bundle, { provider: "cloudflare", metrics: { forge_requests_total: "available", forge_request_duration_ms: "available", forge_outbox_delivered_total: "available", forge_decisions_total: "available", forge_telemetry_dropped_total: "available", forge_trace_spans: "available" } });
    const create = d.panels.find((p) => p.id === "latency:@acme/commerce/_/Customer.create")!;
    expect(create.buckets).toEqual([5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
    expect(create.slo).toEqual({ availability: "99.9%", latencyGood: "99%", latencyWithinMs: 1000, window: "28d" }); // crud-write class from forge.toml
    expect(d.panels.find((p) => p.id === "latency:@acme/commerce/_/Customer.get")!.slo!.latencyWithinMs).toBe(500); // crud-read
    const submit = d.panels.find((p) => p.id === "avail:@acme/commerce/_/SubmitOrder")!;
    expect(submit.group).toBe("function");
    expect(submit.slo!.latencyWithinMs).toBe(1000);
    expect(submit.query).toContain('forge_phase="completion"'); // attempts never inflate the denominator
    // workflow transitions and observed edges are not exposed by this provider: missing, with a note
    expect(d.panels.find((p) => p.id === "workflow:@acme/commerce/_/ProcessOrder")!.status).toBe("missing");
    expect(d.panels.find((p) => p.id === "grants:edges")!.status).toBe("missing");
    expect(d.uncertainty.some((u) => u.includes("forge_workflow_transitions_total") && u.includes("not zero"))).toBe(true);
    const grafana = toGrafana(d) as { panels: { type: string; title: string; options?: { content: string } }[] };
    const missing = grafana.panels.find((p) => p.title.startsWith("ProcessOrder transitions"))!;
    expect(missing.type).toBe("text");
    expect(missing.options!.content).toMatch(/no data is not zero/);
    expect(d.panels.find((p) => p.id === "coverage:traces")!.status).toBe("sampled");
    expect(d.rules.find((r) => r.id === "burn:@acme/commerce/_/Customer.create")!.note).toMatch(/completions only/);
    expect(d.panels.map((p) => p.group)).toEqual(expect.arrayContaining(["function", "resource", "channel", "workflow", "grant", "privacy", "coverage"]));
  });

  it("PAR-167: the error budget shows a band when exports were lost and refuses a claim with no completions", () => {
    expect(errorBudget({ good: 0, bad: 0, dropped: 0, sloAvailability: "99.9%", window: "28d" })).toMatchObject({ consumed: null, band: null });
    const clean = errorBudget({ good: 9990, bad: 5, dropped: 0, sloAvailability: "99.9%", window: "28d" });
    expect(clean.consumed).toBeCloseTo(0.5, 2);
    expect(clean.band![0]).toBeCloseTo(clean.band![1], 6);
    const gappy = errorBudget({ good: 9990, bad: 5, dropped: 100, sloAvailability: "99.9%", window: "28d" });
    expect(gappy.band![1]).toBeGreaterThan(gappy.consumed!);
    expect(gappy.band![0]).toBeLessThan(gappy.consumed!);
    expect(gappy.note).toMatch(/not at the point/);
  });
});
