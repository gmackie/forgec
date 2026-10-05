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
  /** Artifact identity and source-map anchor, excluded from metric dimensions. */
  buildHash?: string;
  semanticAnchor?: string;
  kind: string;
  resource?: string;
  outcome: Outcome;
  status: number;
  code?: string;
  durationMs: number;
  /** One per logical operation; retries increment `attempt` on the same logical event. */
  logical: true;
  attempt: number;
  /** `completion` is the one event per logical request; `attempt` events are retried tries that did not complete it. */
  phase: "attempt" | "completion";
  requestId: string;
  target: string;
  trace?: TraceContext;
  // ---- governance context (FORGE-082): bounded identifiers only, never values
  /** Purpose id, or an opaque stable handle (`p:<12 hex>`) when the purpose's handling is confidential (PAR-165). */
  purpose?: string;
  /** Capability surface digest (12 hex) the call was projected through. */
  surface?: string;
  /** Last authorizer decision on the call path: allow | deny | none (no authorizer / maintenance). */
  decision?: "allow" | "deny" | "none";
  policyEpoch?: number;
  grantEpoch?: number;
}
export interface TelemetrySink { write(e: OperationEvent): void }

/** SLI classification policy from the plan (§20): declared domain errors are business outcomes, not failures. */
export function classify(status: number, code?: string): Outcome {
  if (status < 400) return "good";
  if (code && code.includes("/")) return "business";
  if (code === "TransientConflict" || status >= 500) return "bad";
  return "excluded";
}

const DIMENSIONS = ["forge.operation", "forge.kind", "forge.resource", "forge.outcome", "forge.target", "forge.purpose", "forge.decision"] as const;

export interface SliSummary { requests: number; good: number; bad: number; business: number; excluded: number; attempts: number; transportFailures: number; coverage: { emitted: number; dropped: number } }

export class Telemetry {
  sink: TelemetrySink | null = null;
  target = "runtime-memory";
  /** Purpose handling overrides (purpose id -> handling); `confidential`/`restricted` purposes are emitted as opaque handles. */
  purposeHandling: Record<string, string> = {};
  /** Grant epoch supplied by the host (registry snapshot); 0 when no grants are in force. */
  grantEpoch = 0;
  private seq = 0;
  private emitted = 0;
  private dropped = 0;
  constructor(private readonly engine: Engine) {}

  /** Stable, bounded purpose label: the id, or an HMAC-free hash handle when the name itself is sensitive (PAR-165). */
  purposeLabel(purpose: string | undefined): string | undefined {
    if (!purpose) return undefined;
    const handling = this.purposeHandling[purpose] ?? this.engine.model.purposes.find((p) => p.id === purpose && (p as { handling?: string }).handling)?.["handling" as never];
    if (handling === "confidential" || handling === "restricted") return `p:${fnv(purpose).slice(0, 12)}`;
    return purpose;
  }

  private governance(operation: string, ctx: CallContext, code: string | undefined): Pick<OperationEvent, "purpose" | "surface" | "decision" | "policyEpoch" | "grantEpoch"> {
    const out: Pick<OperationEvent, "purpose" | "surface" | "decision" | "policyEpoch" | "grantEpoch"> = {};
    const purpose = this.purposeLabel(ctx.purpose);
    if (purpose) out.purpose = purpose;
    const ref = this.engine.model.operation(operation);
    const surface = ref && ctx.purpose ? this.engine.scope.surface(ref.resource.id, ctx.purpose) : null;
    if (surface) out.surface = surface.digest.slice(0, 12);
    // The decision the call path took: a scope or authorizer refusal is `deny`; a scoped or authorized call is `allow`;
    // maintenance and unscoped calls without an authorizer took no decision.
    const gated = Boolean(surface) || Boolean(this.engine.gatekeeper.authorizer && !ctx.maintenance);
    out.decision = code === "NotPermitted" ? "deny" : gated ? "allow" : "none";
    out.policyEpoch = this.engine.gatekeeper.authorizer?.epoch ?? 0;
    if (this.grantEpoch) out.grantEpoch = this.grantEpoch;
    return out;
  }

  /** Plan entry for an operation id; unknown ids (internal ops) still get a generic entry. */
  entry(operation: string): { kind: string; resource?: string } {
    const plan = this.engine.model.bundle.observability?.operations.find((o) => o.operation === operation);
    if (plan) return { kind: plan.kind, ...(plan.resource ? { resource: plan.resource } : {}) };
    const ref = this.engine.model.operation(operation);
    if (ref) return { kind: ref.op.kind, resource: ref.resource.id };
    return { kind: operation.slice(operation.lastIndexOf(".") + 1) };
  }

  emit(operation: string, ctx: CallContext, startedAt: number, status: number, code?: string): void {
    this.write(operation, ctx, Math.round((performance.now() - startedAt) * 1000) / 1000, status, code, "completion");
  }

  /** A retried try that did not complete the logical request (PAR-166): same requestId, next attempt number. */
  attempt(ctx: CallContext, status: number, code?: string, operation = "retry"): void {
    const n = (this.attempts.get(ctx.requestId) ?? 0) + 1;
    this.attempts.set(ctx.requestId, n);
    if (this.attempts.size > 10_000) this.attempts.delete(this.attempts.keys().next().value as string);
    this.write(operation, { ...ctx, attempt: n }, 0, status, code, "attempt");
  }
  private readonly attempts = new Map<string, number>();

  private write(operation: string, ctx: CallContext, durationMs: number, status: number, code: string | undefined, phase: OperationEvent["phase"]): void {
    const { kind, resource } = this.entry(operation);
    const ref = this.engine.model.operation(operation);
    const semanticAnchor = ref ? `${ref.resource.id}#op:${operation.slice(ref.resource.id.length + 1)}` : this.engine.model.functions.some(f => f.id === operation) ? operation : undefined;
    const ev: OperationEvent = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      operation,
      buildHash: this.engine.model.bundle.buildHash,
      ...(semanticAnchor ? { semanticAnchor } : {}),
      kind,
      ...(resource ? { resource } : {}),
      outcome: classify(status, code),
      status,
      ...(code ? { code } : {}),
      durationMs,
      logical: true,
      attempt: ctx.attempt ?? (phase === "completion" ? Math.max(1, this.attempts.get(ctx.requestId) ?? 0) : 1),
      phase,
      requestId: ctx.requestId,
      target: this.target,
      ...(ctx.trace ? { trace: ctx.trace } : {}),
      ...this.governance(operation, ctx, code),
    };
    if (phase === "completion") this.attempts.delete(ctx.requestId);
    this.emitted++;
    try {
      this.sink?.write(ev);
    } catch {
      this.dropped++; // export gap: counted, never thrown into the operation
    }
  }

  /** SLI denominators: completions are requests; attempts are counted separately; export loss is coverage, not error. */
  sli(events: OperationEvent[]): SliSummary {
    const completions = events.filter((e) => e.phase === "completion");
    return {
      requests: completions.length,
      good: completions.filter((e) => e.outcome === "good").length,
      bad: completions.filter((e) => e.outcome === "bad").length,
      business: completions.filter((e) => e.outcome === "business").length,
      excluded: completions.filter((e) => e.outcome === "excluded").length,
      attempts: events.length,
      transportFailures: events.filter((e) => e.code === "TransportFailed").length,
      coverage: { emitted: this.emitted, dropped: this.dropped },
    };
  }

  /** Bounded metric dimensions only. */
  dimensions(e: OperationEvent): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of DIMENSIONS) {
      const v = d === "forge.operation" ? e.operation : d === "forge.kind" ? e.kind : d === "forge.resource" ? (e.resource ?? "") : d === "forge.outcome" ? e.outcome : d === "forge.purpose" ? (e.purpose ?? "") : d === "forge.decision" ? (e.decision ?? "") : e.target;
      if (v) out[d] = v;
    }
    return out;
  }

  stats(): { emitted: number; dropped: number; seq: number } {
    return { emitted: this.emitted, dropped: this.dropped, seq: this.seq };
  }
}

/** Small stable hash for opaque handles (not a secret: the handle hides the name from casual readers, access control hides it from the rest). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let h2 = 0x01000193;
  for (let i = s.length - 1; i >= 0; i--) {
    h2 ^= s.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
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
