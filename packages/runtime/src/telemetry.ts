/**
 * Telemetry (plan §20). One unsampled operation event per logical operation,
 * classified by the compiled observability plan: `good`, `excluded` (client
 * errors that do not count against availability), `bad` (failures that do),
 * `business` (declared domain errors: served correctly, counted separately).
 * Dimensions are bounded to the plan's list; tenant, ids and inputs never
 * become labels. A per-process sequence number makes export gaps visible:
 * `stats()` reports emitted vs dropped.
 */
import type { CallContext, Engine } from "./engine.js";

export type Outcome = "good" | "excluded" | "bad" | "business";
export interface TraceContext { traceId: string; spanId: string; parentSpanId?: string }
export interface OperationEvent {
  ts: string;
  seq: number;
  operation: string;
  kind: string;
  resource?: string;
  outcome: Outcome;
  status: number;
  code?: string;
  durationMs: number;
  /** One per logical operation; retries increment `attempt` on the same logical event. */
  logical: true;
  attempt: number;
  requestId: string;
  target: string;
  trace?: TraceContext;
}
export interface TelemetrySink { write(e: OperationEvent): void }

/** SLI classification policy from the plan (§20): declared domain errors are business outcomes, not failures. */
export function classify(status: number, code?: string): Outcome {
  if (status < 400) return "good";
  if (code && code.includes("/")) return "business";
  if (code === "TransientConflict" || status >= 500) return "bad";
  return "excluded";
}

const DIMENSIONS = ["forge.operation", "forge.kind", "forge.resource", "forge.outcome", "forge.target"] as const;

export class Telemetry {
  sink: TelemetrySink | null = null;
  target = "runtime-memory";
  private seq = 0;
  private emitted = 0;
  private dropped = 0;
  constructor(private readonly engine: Engine) {}

  /** Plan entry for an operation id; unknown ids (internal ops) still get a generic entry. */
  entry(operation: string): { kind: string; resource?: string } {
    const plan = this.engine.model.bundle.observability?.operations.find((o) => o.operation === operation);
    if (plan) return { kind: plan.kind, ...(plan.resource ? { resource: plan.resource } : {}) };
    const ref = this.engine.model.operation(operation);
    if (ref) return { kind: ref.op.kind, resource: ref.resource.id };
    return { kind: operation.slice(operation.lastIndexOf(".") + 1) };
  }

  emit(operation: string, ctx: CallContext, startedAt: number, status: number, code?: string): void {
    const { kind, resource } = this.entry(operation);
    const ev: OperationEvent = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      operation,
      kind,
      ...(resource ? { resource } : {}),
      outcome: classify(status, code),
      status,
      ...(code ? { code } : {}),
      durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      logical: true,
      attempt: 1,
      requestId: ctx.requestId,
      target: this.target,
      ...(ctx.trace ? { trace: ctx.trace } : {}),
    };
    this.emitted++;
    try {
      this.sink?.write(ev);
    } catch {
      this.dropped++; // export gap: counted, never thrown into the operation
    }
  }

  /** Bounded metric dimensions only. */
  dimensions(e: OperationEvent): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of DIMENSIONS) {
      const v = d === "forge.operation" ? e.operation : d === "forge.kind" ? e.kind : d === "forge.resource" ? (e.resource ?? "") : d === "forge.outcome" ? e.outcome : e.target;
      if (v) out[d] = v;
    }
    return out;
  }

  stats(): { emitted: number; dropped: number; seq: number } {
    return { emitted: this.emitted, dropped: this.dropped, seq: this.seq };
  }
}

// ------------------------------------------------------------ trace context
const HEX16 = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const HEX32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Parse an incoming W3C `traceparent` and start a child span; without one, start a new trace. */
export function spanFromTraceparent(header: string | null): TraceContext {
  const m = header && /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(header.trim());
  if (m) return { traceId: m[1]!.toLowerCase(), spanId: HEX16(), parentSpanId: m[2]!.toLowerCase() };
  return { traceId: HEX32(), spanId: HEX16() };
}
export function traceparent(t: TraceContext): string {
  return `00-${t.traceId}-${t.spanId}-01`;
}

// ------------------------------------------------------------- host sinks
/** Workers Logs: one structured JSON line per event. */
export function workersLogLine(e: OperationEvent): string {
  return JSON.stringify({ forge: "operation", ...e });
}

/** CloudWatch Embedded Metric Format: count + duration histogram with bounded dimensions. */
export function emfLine(e: OperationEvent, namespace: string): string {
  return JSON.stringify({
    _aws: {
      Timestamp: Date.parse(e.ts),
      CloudWatchMetrics: [{ Namespace: namespace, Dimensions: [["forge.operation", "forge.outcome"]], Metrics: [{ Name: "forge.operation.count", Unit: "Count" }, { Name: "forge.operation.duration_ms", Unit: "Milliseconds" }] }],
    },
    "forge.operation": e.operation,
    "forge.outcome": e.outcome,
    "forge.operation.count": 1,
    "forge.operation.duration_ms": e.durationMs,
    "forge.kind": e.kind,
    ...(e.resource ? { "forge.resource": e.resource } : {}),
    "forge.target": e.target,
    status: e.status,
    ...(e.code ? { code: e.code } : {}),
    requestId: e.requestId,
    seq: e.seq,
    ...(e.trace ? { traceId: e.trace.traceId, spanId: e.trace.spanId } : {}),
  });
}
