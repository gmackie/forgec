/**
 * OTLP/HTTP (JSON) exporter sink (closes SR-6). Turns OperationEvents into
 * OpenTelemetry log records and metrics — a request counter, an attempt
 * counter and a duration histogram with the plan's exact bucket boundaries —
 * with the same bounded attribute set the other sinks use (never tenant,
 * actor, ids or inputs). Export is batched and asynchronous; a failed export
 * is counted as loss (`stats().dropped`) and never surfaces into the
 * operation. Trace context rides along as `traceId`/`spanId` on log records.
 */
import type { OperationEvent, TelemetrySink } from "./telemetry.js";

export interface OtlpOptions {
  /** Base endpoint, e.g. http://collector:4318 ; `/v1/logs` and `/v1/metrics` are appended. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName: string;
  /** Histogram boundaries (ms) by operation id, from the observability plan. */
  boundaries?: Record<string, number[]>;
  flushIntervalMs?: number;
  maxBatch?: number;
  fetch?: typeof fetch;
}

const ATTRS = ["operation", "kind", "resource", "outcome", "target", "purpose", "decision", "phase"] as const;
const DEFAULT_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

type Attr = { key: string; value: { stringValue: string } | { intValue: string } };
const attrs = (e: OperationEvent): Attr[] => {
  const out: Attr[] = [];
  for (const k of ATTRS) {
    const v = e[k];
    if (v !== undefined && v !== "") out.push({ key: `forge.${k}`, value: { stringValue: String(v) } });
  }
  out.push({ key: "forge.status", value: { intValue: String(e.status) } });
  if (e.code) out.push({ key: "forge.code", value: { stringValue: e.code } });
  if (e.policyEpoch !== undefined) out.push({ key: "forge.policy_epoch", value: { intValue: String(e.policyEpoch) } });
  return out;
};

export class OtlpSink implements TelemetrySink {
  private batch: OperationEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private exported = 0;
  private dropped = 0;
  private inflight: Promise<void> | null = null;
  constructor(private readonly o: OtlpOptions) {}

  write(e: OperationEvent): void {
    this.batch.push(e);
    if (this.batch.length >= (this.o.maxBatch ?? 100)) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.o.flushIntervalMs ?? 1000);
      this.timer.unref?.();
    }
  }

  stats(): { exported: number; dropped: number; pending: number } {
    return { exported: this.exported, dropped: this.dropped, pending: this.batch.length };
  }

  /** OTLP payloads for a batch (exposed for tests and for hosts that ship their own transport). */
  payloads(events: OperationEvent[]): { logs: unknown; metrics: unknown } {
    const resource = { attributes: [{ key: "service.name", value: { stringValue: this.o.serviceName } }, { key: "telemetry.sdk.name", value: { stringValue: "forge" } }] };
    const nano = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);
    const logRecords = events.map((e) => ({
      timeUnixNano: nano(e.ts),
      severityNumber: e.outcome === "bad" ? 17 : e.outcome === "business" ? 13 : 9,
      severityText: e.outcome === "bad" ? "ERROR" : e.outcome === "business" ? "WARN" : "INFO",
      body: { stringValue: `${e.operation} ${e.outcome} ${e.status}` },
      attributes: [...attrs(e), { key: "forge.request_id", value: { stringValue: e.requestId } }, { key: "forge.attempt", value: { intValue: String(e.attempt) } }],
      ...(e.trace ? { traceId: e.trace.traceId, spanId: e.trace.spanId } : {}),
    }));
    // metrics: one data point per distinct attribute set in the batch
    const groups = new Map<string, { attributes: Attr[]; events: OperationEvent[] }>();
    for (const e of events) {
      const a = attrs(e).filter((x) => x.key !== "forge.status" && x.key !== "forge.code" && x.key !== "forge.policy_epoch");
      const key = a.map((x) => `${x.key}=${JSON.stringify(x.value)}`).join("|");
      const g = groups.get(key) ?? { attributes: a, events: [] };
      g.events.push(e);
      groups.set(key, g);
    }
    const now = nano(new Date().toISOString());
    const completions = [...groups.values()].map((g) => ({ attributes: g.attributes, timeUnixNano: now, asInt: String(g.events.filter((e) => e.phase === "completion").length) })).filter((p) => p.asInt !== "0");
    const attempts = [...groups.values()].map((g) => ({ attributes: g.attributes, timeUnixNano: now, asInt: String(g.events.length) }));
    const histogram = [...groups.values()].filter((g) => g.events.some((e) => e.phase === "completion")).map((g) => {
      const op = g.events[0]!.operation;
      const bounds = this.o.boundaries?.[op] ?? DEFAULT_BOUNDS;
      const counts = new Array<number>(bounds.length + 1).fill(0);
      let sum = 0;
      const done = g.events.filter((e) => e.phase === "completion");
      for (const e of done) {
        sum += e.durationMs;
        let i = bounds.findIndex((b) => e.durationMs <= b);
        if (i < 0) i = bounds.length;
        counts[i]!++;
      }
      return { attributes: g.attributes, timeUnixNano: now, count: String(done.length), sum, bucketCounts: counts.map(String), explicitBounds: bounds };
    });
    const metrics = [
      { name: "forge_requests_total", description: "logical operations completed (attempts excluded)", unit: "1", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: completions } },
      { name: "forge_attempts_total", description: "tries including retries", unit: "1", sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: attempts } },
      { name: "forge_request_duration_ms", description: "completion latency with the plan's buckets", unit: "ms", histogram: { aggregationTemporality: 1, dataPoints: histogram } },
      { name: "forge_telemetry_dropped_total", description: "events lost at export", unit: "1", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ attributes: [], timeUnixNano: now, asInt: String(this.dropped) }] } },
    ];
    return { logs: { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "forge" }, logRecords }] }] }, metrics: { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: "forge" }, metrics }] }] } };
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inflight) await this.inflight;
    const events = this.batch;
    if (events.length === 0) return;
    this.batch = [];
    const f = this.o.fetch ?? fetch;
    const { logs, metrics } = this.payloads(events);
    const headers = { "content-type": "application/json", ...(this.o.headers ?? {}) };
    this.inflight = (async () => {
      try {
        const [l, m] = await Promise.all([f(`${this.o.endpoint.replace(/\/$/, "")}/v1/logs`, { method: "POST", headers, body: JSON.stringify(logs) }), f(`${this.o.endpoint.replace(/\/$/, "")}/v1/metrics`, { method: "POST", headers, body: JSON.stringify(metrics) })]);
        if (l.ok && m.ok) this.exported += events.length;
        else this.dropped += events.length;
      } catch {
        this.dropped += events.length; // loss is counted, never thrown into an operation
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }
}
