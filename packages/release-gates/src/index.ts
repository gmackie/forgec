/**
 * Governed previews and staged release gates (FORGE-071; PAR-147).
 *
 * A preview is an isolated deployment whose data policy is production's:
 * fields are treated by their data semantics (direct identifiers are
 * pseudonymized deterministically, unclassified restricted content on a
 * subject-bearing resource is redacted, structural fields are kept), never
 * branched from a production database as-is. Promotion needs evidence: the
 * SLO gate returns `insufficient-evidence` (not a pass) below the minimum
 * sample count, window, or when a metric is missing. Acknowledgments are
 * HMAC-signed over the artifact, stage and gate result. Cleanup retains by
 * default; deletion needs a recorded decision.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AppBundle } from "@forgegraph/runtime";

export type Treatment = "keep" | "pseudonymize" | "redact";
export interface FieldTreatment { resource: string; field: string; class: string; treatment: Treatment; why: string }
export interface PreviewProfile {
  name: string;
  source: "production" | "synthetic";
  isolation: "isolated";
  retention: { ttlHours: number; onExpiry: "retain-then-review" };
  fields: FieldTreatment[];
  /** Salt for deterministic pseudonyms within this preview (never the production secret). */
  salt: string;
}

export function previewProfile(bundle: AppBundle, o: { name: string; source: "production" | "synthetic"; ttlHours: number }): PreviewProfile {
  if ((o.source as string) !== "production" && (o.source as string) !== "synthetic") throw new Error(`preview source ${String(o.source)} is not allowed: database branching of production bypasses classification and retention`);
  const subjects = new Set((bundle.dataSemantics?.subjects ?? []).map((s) => s.resource));
  const fields: FieldTreatment[] = [];
  for (const f of bundle.dataSemantics?.fields ?? []) {
    let treatment: Treatment = "keep";
    let why = "structural or internal";
    if (o.source === "production") {
      if (f.personal === "yes" && f.identifiability === "direct") { treatment = "pseudonymize"; why = `direct identifier (${f.class})`; }
      else if (f.personal === "yes") { treatment = "redact"; why = `personal data (${f.class})`; }
      else if (f.handling === "restricted" && subjects.has(f.resource)) { treatment = "redact"; why = "unclassified restricted content on a subject-bearing resource"; }
      else if (f.handling === "restricted" || f.handling === "confidential") { treatment = "pseudonymize"; why = `${f.handling} value; pseudonymized to keep joins and uniqueness`; }
    }
    fields.push({ resource: f.resource, field: f.field, class: f.class, treatment, why });
  }
  return { name: o.name, source: o.source, isolation: "isolated", retention: { ttlHours: o.ttlHours, onExpiry: "retain-then-review" }, fields: fields.sort((a, b) => `${a.resource}.${a.field}`.localeCompare(`${b.resource}.${b.field}`)), salt: createHash("sha256").update(`preview:${o.name}`).digest("hex").slice(0, 16) };
}

function pseudonym(profile: PreviewProfile, value: unknown, cls: string): unknown {
  if (typeof value !== "string") return value;
  const h = createHash("sha256").update(`${profile.salt}|${value}`).digest("hex").slice(0, 16);
  if (cls.includes("email")) return `${h}@preview.invalid`;
  return `p_${h}`;
}

/** Apply the profile to one record: same keys, treated values, deterministic within the preview. */
export function sanitize(profile: PreviewProfile, resource: string, record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    const t = profile.fields.find((f) => f.resource === resource && f.field === k);
    if (!t || t.treatment === "keep") out[k] = v;
    else if (t.treatment === "redact") out[k] = v === null || v === undefined ? v : "[redacted]";
    else out[k] = pseudonym(profile, v, t.class);
  }
  return out;
}

export function cleanupPolicy(o: { ttlHours: number; onExpiry?: "retain-then-review" | "delete"; decision?: { by: string; at: string; reason: string } }): { ttlHours: number; onExpiry: "retain-then-review" | "delete"; deleteRequires: string; decision?: { by: string; at: string; reason: string } } {
  if (o.onExpiry === "delete") {
    if (!o.decision) throw new Error("deleting preview data on expiry requires a recorded decision (by, at, reason); the default is retain-then-review");
    return { ttlHours: o.ttlHours, onExpiry: "delete", deleteRequires: "recorded decision by the owner", decision: o.decision };
  }
  return { ttlHours: o.ttlHours, onExpiry: "retain-then-review", deleteRequires: "recorded decision by the owner" };
}

// ------------------------------------------------------------------ gates
export interface SloTargets { availability: number; latencyP99Ms: number; minSamples: number; windowMinutes: number }
export interface Observed { samples: number; errors: number; latencyP99Ms?: number; windowMinutes: number }
export interface GateResult {
  verdict: "pass" | "fail" | "insufficient-evidence";
  promotable: boolean;
  reason?: string;
  observed: { samples: number; availability: number | null; latencyP99Ms: number | null; windowMinutes: number };
  targets: SloTargets;
}

export function sloGate(targets: SloTargets, o: Observed): GateResult {
  const observed = { samples: o.samples, availability: o.samples > 0 ? (o.samples - o.errors) / o.samples : null, latencyP99Ms: o.latencyP99Ms ?? null, windowMinutes: o.windowMinutes };
  const insufficient = (reason: string): GateResult => ({ verdict: "insufficient-evidence", promotable: false, reason, observed, targets });
  if (o.samples < targets.minSamples) return insufficient(`${o.samples} of ${targets.minSamples} minimum samples: not enough traffic to claim the SLO`);
  if (o.windowMinutes < targets.windowMinutes) return insufficient(`${o.windowMinutes} of ${targets.windowMinutes} minutes observed`);
  if (o.latencyP99Ms === undefined) return insufficient("metric latencyP99Ms is missing: a missing metric is not a passing metric");
  if (observed.availability !== null && observed.availability < targets.availability) return { verdict: "fail", promotable: false, reason: `availability ${observed.availability.toFixed(4)} < ${targets.availability}`, observed, targets };
  if (o.latencyP99Ms > targets.latencyP99Ms) return { verdict: "fail", promotable: false, reason: `latency p99 ${o.latencyP99Ms}ms > ${targets.latencyP99Ms}ms`, observed, targets };
  return { verdict: "pass", promotable: true, observed, targets };
}

export interface Acknowledgment { version: "ack/1"; artifact: string; stage: string; gate: { verdict: string; observed: GateResult["observed"] }; by: string; at: string; signature: string }

const ackMaterial = (a: Omit<Acknowledgment, "signature">) => `forge-ack\n${JSON.stringify([a.version, a.artifact, a.stage, a.gate, a.by, a.at])}`;

export async function acknowledge(o: { artifact: string; stage: string; gate: GateResult; by: string; at?: string }, secret: string): Promise<Acknowledgment> {
  if (o.gate.verdict !== "pass") throw new Error(`cannot acknowledge a ${o.gate.verdict} gate: ${o.gate.reason ?? "no evidence of success"}`);
  const body: Omit<Acknowledgment, "signature"> = { version: "ack/1", artifact: o.artifact, stage: o.stage, gate: { verdict: o.gate.verdict, observed: o.gate.observed }, by: o.by, at: o.at ?? new Date().toISOString() };
  return { ...body, signature: createHmac("sha256", secret).update(ackMaterial(body)).digest("hex") };
}

export async function verifyAcknowledgment(a: Acknowledgment, secret: string): Promise<boolean> {
  const { signature, ...body } = a;
  const expected = createHmac("sha256", secret).update(ackMaterial(body)).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
