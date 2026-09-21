/** FORGE-085/086 / PAR-169, PAR-170, PAR-171: signed evidence scope and drift reports. */
import { describe, expect, it } from "vitest";
import { generateSigner } from "../src/artifacts.js";
import { driftReport, evidenceClaims, signEvidence, verifyEvidence, type EvidencePayload } from "../src/evidence.js";

const payload: EvidencePayload = {
  version: "deployment-evidence/1",
  deployment: "acme-prod",
  hashes: { build: "a".repeat(64), contracts: "contracts/1", grants: "b".repeat(64), policy: "c".repeat(64), adapters: { "cloudflare-d1": "d".repeat(64) } },
  tests: [{ suite: "conformance", profile: "cloudflare-d1/workers/wrangler", passed: 221, failed: 0, skipped: 0, window: { from: "2026-09-20T00:00:00Z", to: "2026-09-20T01:00:00Z" }, ref: "conformance/certification/latest.json" }],
  migrations: [{ job: "forge-acme-prod-migrate", artifact: "a".repeat(64), acknowledgedBy: "ledger", at: "2026-09-20T00:30:00Z" }],
  coverage: { telemetry: { from: "2026-09-13T00:00:00Z", to: "2026-09-20T00:00:00Z", emitted: 98_000, dropped: 2_000, sampledTraces: true } },
  confidential: { artifacts: [{ ref: "pentest-2026-09", audience: ["org:acme:security"] }] },
  producedAt: "2026-09-20T02:00:00Z",
};

describe("PAR-169: evidence signatures prove provenance, claims stay bounded", () => {
  it("verifies, detects tampering, and renders scoped, fresh-or-stale claims without generalizing", async () => {
    const signer = await generateSigner("release");
    const trust = { authority: "registry.acme", signers: { release: signer.publicKey } };
    const b = await signEvidence(payload, signer, "registry.acme");
    expect(await verifyEvidence(b, trust)).toEqual({ ok: true });
    expect((await verifyEvidence({ ...b, payload: { ...b.payload, tests: [{ ...payload.tests[0]!, failed: 0, passed: 999 }] } }, trust)).ok).toBe(false);
    expect((await verifyEvidence(b, { ...trust, signers: {} })).ok).toBe(false);
    const fresh = evidenceClaims(b, { now: Date.parse("2026-09-21T00:00:00Z"), freshnessMs: 7 * 86_400_000, verified: true });
    expect(fresh.claims[0]).toMatchObject({ subject: "conformance", scope: "profile cloudflare-d1/workers/wrangler, 2026-09-20T00:00:00Z .. 2026-09-20T01:00:00Z", state: "verified" });
    expect(fresh.claims.find((c) => c.subject === "telemetry coverage")).toMatchObject({ state: "verified", detail: expect.stringMatching(/98\.00% of events exported; traces sampled/) });
    expect(fresh.claims.find((c) => c.subject === "confidential artifact")).toMatchObject({ state: "unknown", detail: expect.stringMatching(/not disclosed/) });
    expect(evidenceClaims(b, { now: Date.parse("2026-09-21T00:00:00Z"), freshnessMs: 7 * 86_400_000, verified: true, audience: "org:acme:security" }).claims.find((c) => c.subject.startsWith("confidential artifact pentest"))!.state).toBe("verified");
    expect(fresh.disclaimer).toMatch(/does not extend any claim beyond its scope/);
    // stale after the freshness window; unknown when the signature did not verify
    const stale = evidenceClaims(b, { now: Date.parse("2026-12-01T00:00:00Z"), freshnessMs: 7 * 86_400_000, verified: true });
    expect(stale.claims[0]!.state).toBe("stale");
    const unverified = evidenceClaims(b, { now: Date.parse("2026-09-21T00:00:00Z"), freshnessMs: 7 * 86_400_000, verified: false });
    expect(unverified.claims.every((c) => c.state === "unknown")).toBe(true);
    expect(JSON.stringify(fresh)).not.toMatch(/compliant|universal/i);
  });
});

describe("PAR-170/171: drift report qualifies attribution and coverage", () => {
  it("observed edges under workload-bound credentials attribute to the workload; unused grants are review suggestions with coverage", () => {
    const edge = { caller: "acme-prod/commerce", callee: "@acme/payments/_/AuthorizePayment", purpose: "@acme/payments/_/Charge" };
    const ledger = { caller: "acme-prod/commerce", callee: "@acme/ledger/_/Post", purpose: "@acme/ledger/_/Settlement" };
    const r = driftReport({
      declared: [edge, ledger],
      approved: [edge, ledger],
      activated: [edge, ledger],
      observed: [
        { ...edge, assurance: "workload-bound", claimedFunction: "@acme/commerce/_/SubmitOrder", count: 120 },
        { caller: "acme-prod/commerce", callee: "@acme/crm/_/Sync", purpose: "@acme/crm/_/Marketing", assurance: "workload-bound", claimedFunction: "@acme/commerce/_/FunctionA", count: 3 },
      ],
      snapshot: { status: "expired", epoch: 4, expiresAt: "2026-09-20T00:00:00Z" },
      telemetry: { coverage: 0.6, sampled: true, window: { from: "2026-09-13T00:00:00Z", to: "2026-09-20T00:00:00Z" } },
      semanticChanges: [{ code: "surface-narrowed", subject: "@acme/commerce/_/Contact#CustomerSupport", dashboardPanel: "privacy:denials" }],
    });
    expect(r.unexpectedEdges).toHaveLength(1);
    expect(r.unexpectedEdges[0]!.attribution).toMatch(/^workload acme-prod\/commerce \(span claims @acme\/commerce\/_\/FunctionA; unproven/);
    expect(r.unexpectedEdges[0]!.qualifier).toBe("no approved grant for this edge");
    expect(r.unusedGrants).toEqual([{ edge: ledger, suggestion: expect.stringMatching(/sampled telemetry.*60% coverage.*absence is not proof/), coverage: 0.6, automatic: false }]);
    expect(r.snapshot).toMatchObject({ ok: false, status: "expired" });
    expect(r.linked).toEqual([{ code: "surface-narrowed", subject: "@acme/commerce/_/Contact#CustomerSupport", dashboardPanel: "privacy:denials" }]);
    expect(r.qualifiers[0]).toMatch(/assurance tier/);
    // an isolated identity may be attributed to its function
    const iso = driftReport({ declared: [], approved: [], activated: [], observed: [{ ...edge, assurance: "isolated-callable", claimedFunction: "@acme/commerce/_/SubmitOrder", count: 1 }], snapshot: { status: "valid", epoch: 1, expiresAt: "2027-01-01T00:00:00Z" }, telemetry: { coverage: 1, sampled: false, window: { from: "a", to: "b" } } });
    expect(iso.unexpectedEdges[0]!.attribution).toBe("function @acme/commerce/_/SubmitOrder (isolated identity)");
  });
});
