/**
 * Dashboard and SLO-rule projection (FORGE-084; PAR-167/168). One certified
 * dashboard shape (`forge-dashboard/1`, provider-neutral JSON with a Grafana
 * mapping) generated from the observability plan: a panel per function,
 * resource, channel and workflow with the plan's exact histogram buckets and
 * SLO targets, plus grant and privacy panels. A metric the provider does not
 * expose renders as `missing`, never as a healthy zero. Trace-derived panels
 * are marked sampled; error-budget panels carry the export-gap series so
 * uncertainty is visible rather than averaged away.
 */
import type { AppBundle } from "@forgegraph/runtime";

export interface MetricAvailability { provider: string; metrics: Record<string, "available" | "missing" | "sampled"> }
export interface Panel {
  id: string;
  title: string;
  group: "function" | "resource" | "channel" | "workflow" | "grant" | "privacy" | "coverage";
  metric: string;
  status: "available" | "missing" | "sampled";
  /** Exact histogram boundaries from the plan (ms); absent for counters. */
  buckets?: number[];
  slo?: { availability: string; latencyGood: string; latencyWithinMs: number; window: string };
  query: string;
  note?: string;
  providerLink?: string;
}
export interface Rule { id: string; panel: string; expr: string; for: string; severity: "page" | "ticket"; note: string }
export interface Dashboard { version: "forge-dashboard/1"; package: string; artifact: string; provider: string; panels: Panel[]; rules: Rule[]; uncertainty: string[] }

const METRICS = {
  requests: "forge_requests_total",
  latency: "forge_request_duration_ms",
  attempts: "forge_attempts_total",
  outbox: "forge_outbox_delivered_total",
  workflow: "forge_workflow_transitions_total",
  decisions: "forge_decisions_total",
  edges: "forge_edges_observed_total",
  loss: "forge_telemetry_dropped_total",
  traces: "forge_trace_spans",
} as const;

export function dashboard(bundle: AppBundle, avail: MetricAvailability): Dashboard {
  const obs = bundle.observability!;
  const panels: Panel[] = [];
  const rules: Rule[] = [];
  const status = (m: string): Panel["status"] => avail.metrics[m] ?? "missing";
  const link = (kind: string, name: string) => `provider://${avail.provider}/${kind}/${encodeURIComponent(name)}`;
  const short = (id: string) => id.slice(id.lastIndexOf("/_/") + 3);
  for (const op of obs.operations) {
    const group: Panel["group"] = op.kind === "function" ? "function" : "resource";
    const sel = `forge_operation="${op.operation}",forge_phase="completion"`;
    panels.push({ id: `avail:${op.operation}`, title: `${short(op.operation)} availability`, group, metric: METRICS.requests, status: status(METRICS.requests), slo: op.slo, query: `sum(rate(${METRICS.requests}{${sel},forge_outcome="good"}[5m])) / sum(rate(${METRICS.requests}{${sel},forge_outcome=~"good|bad"}[5m]))`, note: "business outcomes are excluded from the denominator; attempts are not requests", providerLink: link("metric", METRICS.requests) });
    panels.push({ id: `latency:${op.operation}`, title: `${short(op.operation)} latency p99`, group, metric: METRICS.latency, status: status(METRICS.latency), buckets: op.histogramBoundariesMs, slo: op.slo, query: `histogram_quantile(0.99, sum(rate(${METRICS.latency}_bucket{${sel}}[5m])) by (le))`, providerLink: link("metric", METRICS.latency) });
    rules.push({ id: `burn:${op.operation}`, panel: `avail:${op.operation}`, expr: `(1 - availability) > (1 - ${parseFloat(op.slo.availability) / 100}) * 14.4`, for: "5m", severity: "page", note: `fast burn against ${op.slo.availability} over ${op.slo.window}; evaluated on completions only` });
  }
  for (const c of (bundle.messaging?.channels ?? []) as { id: string; name: string }[]) {
    panels.push({ id: `channel:${c.id}`, title: `${c.name} deliveries`, group: "channel", metric: METRICS.outbox, status: status(METRICS.outbox), query: `sum(rate(${METRICS.outbox}{forge_channel="${c.id}"}[5m])) by (forge_status)`, providerLink: link("queue", c.name) });
  }
  for (const w of (bundle.workflows?.workflows ?? []) as { id: string; name: string }[]) {
    panels.push({ id: `workflow:${w.id}`, title: `${w.name} transitions`, group: "workflow", metric: METRICS.workflow, status: status(METRICS.workflow), query: `sum(rate(${METRICS.workflow}{forge_workflow="${w.id}"}[5m])) by (forge_status)`, providerLink: link("workflow", w.name) });
  }
  panels.push({ id: "grants:decisions", title: "Authorization decisions", group: "grant", metric: METRICS.decisions, status: status(METRICS.decisions), query: `sum(rate(${METRICS.decisions}[5m])) by (forge_decision, forge_purpose)`, note: "purpose labels are opaque handles where the purpose is confidential" });
  panels.push({ id: "grants:edges", title: "Observed cross-service edges", group: "grant", metric: METRICS.edges, status: status(METRICS.edges), query: `sum(rate(${METRICS.edges}[1h])) by (forge_caller, forge_callee, forge_purpose)`, note: "attribution is qualified by the caller's assurance tier; workload-bound callers cannot be resolved to a function" });
  panels.push({ id: "privacy:denials", title: "Purpose-scope refusals", group: "privacy", metric: METRICS.decisions, status: status(METRICS.decisions), query: `sum(rate(${METRICS.decisions}{forge_decision="deny"}[5m])) by (forge_resource)` });
  panels.push({ id: "coverage:loss", title: "Telemetry export loss", group: "coverage", metric: METRICS.loss, status: status(METRICS.loss), query: `sum(rate(${METRICS.loss}[5m]))`, note: "a gap here widens every error budget above; the budget is not a point estimate while this is non-zero" });
  panels.push({ id: "coverage:traces", title: "Trace spans (sampled)", group: "coverage", metric: METRICS.traces, status: avail.metrics[METRICS.traces] === "available" ? "sampled" : status(METRICS.traces), query: `sum(rate(${METRICS.traces}[5m]))`, note: "traces are sampled: never an exact count; use the metrics panels for SLOs" });
  const uncertainty = [
    "error budgets are computed from completion counters only; telemetry loss (coverage:loss) is shown alongside and widens the interval",
    "trace-derived panels are sampled and never claim exact counts",
    ...panels.filter((p) => p.status === "missing").map((p) => `${p.id}: metric ${p.metric} is not exposed by ${avail.provider}; shown as missing, not zero`),
  ];
  return { version: "forge-dashboard/1", package: bundle.ir.package.name, artifact: bundle.buildHash, provider: avail.provider, panels, rules, uncertainty };
}

/** Error budget from counters with an explicit uncertainty band from export loss (PAR-167). */
export function errorBudget(o: { good: number; bad: number; dropped: number; sloAvailability: string; window: string }): { consumed: number | null; remaining: number | null; band: [number, number] | null; note: string } {
  const target = parseFloat(o.sloAvailability) / 100;
  const total = o.good + o.bad;
  if (total === 0) return { consumed: null, remaining: null, band: null, note: "no completions observed in the window: no claim" };
  const allowed = (1 - target) * total;
  const consumedPoint = o.bad / Math.max(allowed, 1e-9);
  // dropped events could all have been bad, or all good: the band brackets both possibilities
  const worst = (o.bad + o.dropped) / Math.max((1 - target) * (total + o.dropped), 1e-9);
  const best = o.bad / Math.max((1 - target) * (total + o.dropped), 1e-9);
  return { consumed: consumedPoint, remaining: 1 - consumedPoint, band: [best, worst], note: o.dropped ? `${o.dropped} events were not exported: the budget lies in the band, not at the point` : "complete export in the window" };
}

/** Grafana dashboard JSON from the neutral shape (missing panels become text panels saying so). */
export function toGrafana(d: Dashboard): Record<string, unknown> {
  return {
    title: `${d.package} (${d.artifact.slice(0, 12)})`,
    schemaVersion: 39,
    tags: ["forge", d.provider],
    panels: d.panels.map((p, i) => p.status === "missing"
      ? { id: i + 1, type: "text", title: `${p.title} — missing`, options: { content: `Metric ${p.metric} is not available on ${d.provider}. This panel is intentionally empty: no data is not zero.` } }
      : { id: i + 1, type: p.buckets ? "heatmap" : "timeseries", title: p.title + (p.status === "sampled" ? " (sampled)" : ""), targets: [{ expr: p.query }], ...(p.slo ? { fieldConfig: { defaults: { thresholds: { steps: [{ value: parseFloat(p.slo.availability) / 100 }] } } } } : {}), ...(p.providerLink ? { links: [{ title: "provider", url: p.providerLink }] } : {}) }),
  };
}
