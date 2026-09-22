/**
 * Classification-aware logs, audit values and redaction (FORGE-083; PAR-164).
 * Every generated log/audit event is built from an allowlist: operation
 * metadata and governance identifiers from the runtime's OperationEvent,
 * never input or record values. Values reach a sink only through
 * `auditValue`, which applies the field's classification: structural values
 * pass, direct identifiers become keyed tokens, everything personal or
 * restricted is redacted. Sink policies are explicit (logs never carry
 * values; audit carries tokens; metrics carry labels only). Raw logging in
 * handwritten code is detected and marked as an unmodeled escape: it is
 * reported, never labelled proven safe.
 */
import { createHmac } from "node:crypto";
import type { AppBundle, OperationEvent } from "@forgegraph/runtime";

export type Sink = "logs" | "audit" | "metrics" | "errors" | "urls";
export interface SinkPolicy { sink: Sink; values: "none" | "tokens" | "structural"; labels: readonly string[] }

export const SINK_POLICIES: Record<Sink, SinkPolicy> = {
  logs: { sink: "logs", values: "none", labels: ["ts", "operation", "kind", "resource", "outcome", "status", "code", "requestId", "purpose", "surface", "decision", "policyEpoch", "grantEpoch", "attempt", "phase", "durationMs", "target"] },
  audit: { sink: "audit", values: "tokens", labels: ["ts", "operation", "resource", "recordToken", "actorToken", "requestId", "purpose", "decision", "kind"] },
  metrics: { sink: "metrics", values: "none", labels: ["forge.operation", "forge.kind", "forge.resource", "forge.outcome", "forge.target", "forge.purpose", "forge.decision"] },
  errors: { sink: "errors", values: "none", labels: ["code", "status", "requestId", "fields.path", "fields.code"] },
  urls: { sink: "urls", values: "none", labels: ["path", "operation"] },
};

const ALLOWED_EVENT_KEYS = new Set(SINK_POLICIES.logs.labels);

/** A structured log event: the allowlisted subset of an OperationEvent. Anything else is dropped, never serialized. */
export function logEvent(e: OperationEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (ALLOWED_EVENT_KEYS.has(k) && v !== undefined) out[k] = v;
  return out;
}

export interface FieldClass { class: string; handling: string; personal: string; identifiability: string }

export class Redactor {
  private readonly classes = new Map<string, FieldClass>();
  /** Fields whose values are identifiers (ids and references): bounded in type, unbounded in value, so always tokenized. */
  private readonly identifiers = new Set<string>();
  private readonly collections = new Set<string>();
  constructor(bundle: AppBundle, private readonly key = "forge-audit-key") {
    for (const f of bundle.dataSemantics?.fields ?? []) this.classes.set(`${f.resource}.${f.field}`, { class: f.class, handling: f.handling, personal: f.personal, identifiability: f.identifiability });
    for (const f of bundle.dataSemantics?.fields ?? []) if(f.field.includes("[]")) this.collections.add(`${f.resource}.${f.field.slice(0,f.field.indexOf("[]"))}`);
    for (const m of bundle.ir.modules) for (const r of m.resources) for (const f of r.fields) if (f.type.base.kind === "reference" || (f.type.base.kind === "scalar" && f.type.base.name === "id")) this.identifiers.add(`${r.id}.${f.name}`);
  }
  classOf(resource: string, field: string): FieldClass | undefined {
    return this.classes.get(`${resource}.${field}`);
  }
  token(value: string): string {
    return `t:${createHmac("sha256", this.key).update(value).digest("hex").slice(0, 16)}`;
  }
  /** The controlled form of one value for a sink, decided by classification (unknown fields are treated as restricted). */
  auditValue(resource: string, field: string, value: unknown, sink: Sink = "audit"): unknown {
    const policy = SINK_POLICIES[sink];
    if (policy.values === "none") return undefined;
    if (value === null || value === undefined) return value;
    const c = this.classOf(resource, field);
    if (!c) return "[redacted:unclassified]";
    if (this.collections.has(`${resource}.${field}`)) {
      // Container labels cannot downgrade sensitive children. Redact the container conservatively
      // until a sink has an explicit element-level release policy.
      return "[redacted:collection]";
    }
    if (this.identifiers.has(`${resource}.${field}`)) return this.token(String(value));
    if (c.class === "data.structural" && c.personal === "no") return c.identifiability !== "none" ? this.token(String(value)) : value;
    if (c.personal === "yes" && c.identifiability === "direct") return this.token(String(value));
    return "[redacted]";
  }
  /** Redact a record for a sink: same keys, controlled values. */
  auditRecord(resource: string, record: Record<string, unknown>, sink: Sink = "audit"): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      const r = this.auditValue(resource, k, v, sink);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  /** An error for a client or a log: field paths and codes only; messages are re-generated from codes, never echoing values. */
  safeProblem(problem: Record<string, unknown>): Record<string, unknown> {
    const fields = Array.isArray(problem["fields"]) ? (problem["fields"] as { path: string; code: string }[]).map((f) => ({ path: f.path, code: f.code })) : undefined;
    return { code: problem["code"], status: problem["status"], requestId: problem["requestId"], ...(fields ? { fields } : {}) };
  }
}

/** Handwritten code that writes to a raw logger is an unmodeled escape: listed with its location, never marked safe. */
export function rawLoggingEscapes(source: string, file = "impl"): { file: string; line: number; call: string; verdict: "unmodeled" }[] {
  const out: { file: string; line: number; call: string; verdict: "unmodeled" }[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /\b(console\.(log|info|warn|error|debug)|process\.stdout\.write|process\.stderr\.write)\s*\(/.exec(lines[i]!);
    if (m) out.push({ file, line: i + 1, call: m[1]!, verdict: "unmodeled" });
  }
  return out;
}

/** Does a serialized sink payload contain any of the given sensitive values? (test helper and CI guard) */
export function leaks(payload: string, sensitive: string[]): string[] {
  return sensitive.filter((s) => s.length > 0 && payload.includes(s));
}
