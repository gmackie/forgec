/**
 * Signed deployment evidence and coverage accounting (FORGE-085/086; PAR-169/170/171).
 *
 * An evidence bundle binds hashes (build, contracts, grants, policy, adapters),
 * test results per exact profile and time window, migration acknowledgments
 * and runtime telemetry coverage windows, signed by a trusted key. A
 * signature proves provenance of exactly those claims; every claim keeps its
 * scope (profile, window) and freshness, and a report renders them as
 * bounded statements. Missing or stale evidence is `unknown`, never inferred.
 *
 * The drift report joins the declared, approved, activated and observed
 * edge graphs with assurance qualifiers: an observed edge under workload-
 * bound credentials attributes to the workload, not to a function; absence
 * in sampled telemetry is a review suggestion with coverage attached, never
 * proof of unused privilege.
 */
import { canonical, digestOf, signBytes, verifyBytes, type Signer, type TrustPolicy } from "./artifacts.js";

export interface TestResult { suite: string; profile: string; passed: number; failed: number; skipped: number; window: { from: string; to: string }; ref: string }
export interface EvidencePayload {
  version: "deployment-evidence/1";
  deployment: string;
  hashes: { build: string; contracts: string; grants?: string; policy?: string; adapters?: Record<string, string> };
  tests: TestResult[];
  migrations: { job: string; artifact: string; acknowledgedBy: string; at: string }[];
  coverage: { telemetry: { from: string; to: string; emitted: number; dropped: number; sampledTraces: boolean } };
  confidential?: { artifacts: { ref: string; audience: string[] }[] };
  producedAt: string;
}
export interface EvidenceBundle { payload: EvidencePayload; signature: { keyId: string; authority: string; signature: string } }

const material = (authority: string, digest: string) => `forge-evidence\n${authority}\n${digest}`;

export async function signEvidence(payload: EvidencePayload, signer: Signer, authority: string): Promise<EvidenceBundle> {
  const digest = digestOf(canonical(payload));
  return { payload, signature: { keyId: signer.keyId, authority, signature: await signBytes(signer, material(authority, digest)) } };
}

export async function verifyEvidence(b: EvidenceBundle, trust: TrustPolicy): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (b.signature.authority !== trust.authority) return { ok: false, reason: `signed under ${b.signature.authority}, trust is ${trust.authority}` };
  const jwk = trust.signers[b.signature.keyId];
  if (!jwk) return { ok: false, reason: `signer ${b.signature.keyId} is not trusted` };
  const digest = digestOf(canonical(b.payload));
  return (await verifyBytes(jwk, b.signature.signature, material(trust.authority, digest))) ? { ok: true } : { ok: false, reason: "signature does not verify: payload altered or key mismatch" };
}

export interface Claim { subject: string; scope: string; state: "verified" | "stale" | "unknown" | "failed"; detail: string; freshness?: string }

/** Bounded claims from an evidence bundle: each names its profile and window; nothing generalizes (PAR-169). */
export function evidenceClaims(b: EvidenceBundle, o: { now: number; freshnessMs: number; verified: boolean; audience?: string }): { claims: Claim[]; disclaimer: string } {
  const claims: Claim[] = [];
  const state = (at: string, ok: boolean): Claim["state"] => (!o.verified ? "unknown" : !ok ? "failed" : o.now - Date.parse(at) > o.freshnessMs ? "stale" : "verified");
  for (const t of b.payload.tests) {
    claims.push({ subject: t.suite, scope: `profile ${t.profile}, ${t.window.from} .. ${t.window.to}`, state: state(t.window.to, t.failed === 0), detail: `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped (${t.ref}); applies to this profile and window only`, freshness: t.window.to });
  }
  for (const m of b.payload.migrations) claims.push({ subject: `migration ${m.job}`, scope: `artifact ${m.artifact.slice(0, 12)}`, state: state(m.at, true), detail: `acknowledged by ${m.acknowledgedBy} at ${m.at}`, freshness: m.at });
  const c = b.payload.coverage.telemetry;
  const ratio = c.emitted + c.dropped === 0 ? null : c.emitted / (c.emitted + c.dropped);
  claims.push({ subject: "telemetry coverage", scope: `${c.from} .. ${c.to}`, state: ratio === null ? "unknown" : state(c.to, true), detail: ratio === null ? "no events in the window" : `${(ratio * 100).toFixed(2)}% of events exported${c.sampledTraces ? "; traces sampled" : ""}`, freshness: c.to });
  if (b.payload.confidential) {
    for (const a of b.payload.confidential.artifacts) {
      if (!o.audience || !a.audience.includes(o.audience)) claims.push({ subject: `confidential artifact`, scope: `audience ${a.audience.join(", ")}`, state: "unknown", detail: "access-controlled: not disclosed to this audience" });
      else claims.push({ subject: `confidential artifact ${a.ref}`, scope: `audience ${a.audience.join(", ")}`, state: o.verified ? "verified" : "unknown", detail: "available to this audience" });
    }
  }
  return { claims, disclaimer: "Each claim is bounded to its profile and time window. A verified signature proves who produced these claims and that they were not altered; it does not extend any claim beyond its scope, and it is not a statement of regulatory compliance." };
}

// ------------------------------------------------------------------- drift
export type Assurance = "workload-bound" | "isolated-callable";
export interface Edge { caller: string; callee: string; purpose: string }
export interface ObservedEdge extends Edge { assurance: Assurance; claimedFunction?: string; count: number }
export interface DriftInput {
  declared: Edge[];
  approved: Edge[];
  activated: Edge[];
  observed: ObservedEdge[];
  snapshot: { status: string; epoch: number; expiresAt: string };
  telemetry: { coverage: number; sampled: boolean; window: { from: string; to: string } };
  semanticChanges?: { code: string; subject: string; dashboardPanel?: string }[];
}
export interface DriftReport {
  unexpectedEdges: { edge: ObservedEdge; attribution: string; qualifier: string }[];
  unusedGrants: { edge: Edge; suggestion: string; coverage: number; automatic: false }[];
  declaredNotApproved: Edge[];
  approvedNotActivated: Edge[];
  snapshot: { status: string; ok: boolean; detail: string };
  linked: { code: string; subject: string; dashboardPanel?: string }[];
  qualifiers: string[];
}

const key = (e: Edge) => `${e.caller}|${e.callee}|${e.purpose}`;

export function driftReport(i: DriftInput): DriftReport {
  const activated = new Set(i.activated.map(key));
  const approved = new Set(i.approved.map(key));
  const declared = new Set(i.declared.map(key));
  const unexpectedEdges: DriftReport["unexpectedEdges"] = [];
  for (const o of i.observed) {
    // attribution never exceeds the assurance tier: a shared-workload credential identifies the workload, not a function (PAR-170)
    const attribution = o.assurance === "isolated-callable" && o.claimedFunction ? `function ${o.claimedFunction} (isolated identity)` : `workload ${o.caller}${o.claimedFunction ? ` (span claims ${o.claimedFunction}; unproven under workload-bound credentials)` : ""}`;
    if (!activated.has(key(o))) unexpectedEdges.push({ edge: o, attribution, qualifier: approved.has(key(o)) ? "approved but not activated for this identity" : "no approved grant for this edge" });
  }
  const observedKeys = new Set(i.observed.map(key));
  const unusedGrants: DriftReport["unusedGrants"] = i.activated.filter((e) => !observedKeys.has(key(e))).map((e) => ({ edge: e, suggestion: `no calls observed in ${i.telemetry.window.from} .. ${i.telemetry.window.to}${i.telemetry.sampled ? " (sampled telemetry)" : ""} at ${(i.telemetry.coverage * 100).toFixed(0)}% coverage: review the grant; absence is not proof of no use`, coverage: i.telemetry.coverage, automatic: false }));
  const snapshotOk = i.snapshot.status === "valid" || i.snapshot.status === "grace";
  return {
    unexpectedEdges,
    unusedGrants,
    declaredNotApproved: i.declared.filter((e) => !approved.has(key(e))),
    approvedNotActivated: i.approved.filter((e) => !activated.has(key(e))),
    snapshot: { status: i.snapshot.status, ok: snapshotOk, detail: snapshotOk ? `epoch ${i.snapshot.epoch} until ${i.snapshot.expiresAt}` : `snapshot ${i.snapshot.status} (epoch ${i.snapshot.epoch}, expired ${i.snapshot.expiresAt}): authority is bounded by the expiry rule` },
    linked: (i.semanticChanges ?? []).map((c) => ({ code: c.code, subject: c.subject, ...(c.dashboardPanel ? { dashboardPanel: c.dashboardPanel } : {}) })),
    qualifiers: [
      "observed edges attribute to the caller's assurance tier only",
      `telemetry coverage ${(i.telemetry.coverage * 100).toFixed(0)}%${i.telemetry.sampled ? ", sampled" : ""}: an edge absent from telemetry may still be exercised`,
      ...(declared.size ? [] : ["no declared graph supplied"]),
    ],
  };
}
