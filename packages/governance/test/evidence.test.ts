/**
 * FORGE-080/081 / PAR-163: recovery claims need measured evidence; retention
 * hides expired items before cleanup; control packs cannot advertise
 * compliance and always expose assumptions, review needs and stale evidence.
 */
import { describe, expect, it } from "vitest";
import { assertCompliance, controlPack, evidenceReport, exportOscal, recoveryEvidence, retentionVisible } from "../src/index.js";

const now = Date.parse("2026-09-21T00:00:00Z");

describe("PAR-163: recovery claims require evidence", () => {
  it("backup configuration without a recent successful drill yields external-evidence-required or stale, never proven RPO/RTO", () => {
    const configured = recoveryEvidence({ backups: { configured: true, kind: "pitr", schedule: "continuous" }, restoreDrills: [], keys: { managed: true }, legalHolds: [], evidenceWindowMs: 90 * 86_400_000 }, now);
    expect(configured.rpoRtoProven).toBe(false);
    expect(configured.checks.find((c) => c.control === "rpo-rto")).toMatchObject({ state: "external-evidence-required" });
    expect(configured.checks.find((c) => c.control === "backup")).toMatchObject({ state: "configured" });
    const stale = recoveryEvidence({ backups: { configured: true }, restoreDrills: [{ at: "2025-01-01T00:00:00Z", rpoMs: 60_000, rtoMs: 900_000, evidenceRef: "drill-2025-01", ok: true }], keys: { managed: true }, legalHolds: [], evidenceWindowMs: 90 * 86_400_000 }, now);
    expect(stale.rpoRtoProven).toBe(false);
    expect(stale.checks.find((c) => c.control === "rpo-rto")).toMatchObject({ state: "stale" });
    const failedDrill = recoveryEvidence({ backups: { configured: true }, restoreDrills: [{ at: "2026-09-01T00:00:00Z", rpoMs: 60_000, rtoMs: 900_000, evidenceRef: "drill-fail", ok: false }], keys: { managed: true }, legalHolds: [], evidenceWindowMs: 90 * 86_400_000 }, now);
    expect(failedDrill.rpoRtoProven).toBe(false);
    const measured = recoveryEvidence({ backups: { configured: true }, restoreDrills: [{ at: "2026-09-01T00:00:00Z", rpoMs: 60_000, rtoMs: 900_000, evidenceRef: "drill-2026-09", ok: true }], keys: { managed: true, rotationDays: 90, lastRotatedAt: "2026-08-01T00:00:00Z" }, legalHolds: [{ id: "h1", scope: "AttendanceRecord", until: "2027-01-01T00:00:00Z" }], evidenceWindowMs: 90 * 86_400_000 }, now);
    expect(measured.rpoRtoProven).toBe(true);
    expect(measured.checks.find((c) => c.control === "rpo-rto")).toMatchObject({ state: "measured", value: { rpoMs: 60_000, rtoMs: 900_000 } });
    expect(measured.checks.find((c) => c.control === "legal-hold:h1")).toMatchObject({ state: "configured" });
  });

  it("expired retention hides items before physical cleanup", () => {
    expect(retentionVisible({ retainUntil: "2026-09-20T00:00:00Z" }, now)).toBe(false);
    expect(retentionVisible({ retainUntil: "2026-09-22T00:00:00Z" }, now)).toBe(true);
    expect(retentionVisible({ ttl: Math.floor(now / 1000) - 1 }, now)).toBe(false); // DynamoDB TTL epoch seconds, not yet cleaned up
    expect(retentionVisible({ ttl: null, retainUntil: null }, now)).toBe(true);
  });
});

describe("control packs", () => {
  const pack = () => controlPack({
    package: "@fixtures/education",
    artifact: "a".repeat(64),
    controls: [
      { id: "TC-ERASURE", title: "Subject erasure through declared bindings", sources: ["packages/governance/test/rights.test.ts"], applicability: { fact: "resources declare @subject", applies: true }, state: "measured", evidence: { ref: "vitest:rights.test.ts#PAR-156", at: "2026-09-21T00:00:00Z" } },
      { id: "TC-SUPPRESSION", title: "Suppression ledger prevents resurrection", sources: ["packages/runtime/src/suppression.ts"], applicability: { fact: "ledger consulted on every commit", applies: true }, state: "measured", evidence: { ref: "vitest:rights.test.ts#PAR-158", at: "2026-05-01T00:00:00Z" } },
      { id: "TC-RESTORE-DRILL", title: "Restore drill within window", sources: ["ops runbook"], applicability: { fact: "backups configured", applies: true }, state: "attested", evidence: { ref: "ticket-4411", at: "2026-09-10T00:00:00Z", by: "sre-lead" }, reviewRequired: true, assumptions: ["drill covered the production region only"] },
      { id: "TC-VENDOR-ERASURE", title: "External processor erasure", sources: [], applicability: { fact: "vendor sinks present", applies: "unknown" }, state: "unknown" },
    ],
  });

  it("cannot advertise blanket compliance; the report leads with assumptions, review requirements and stale evidence", () => {
    expect(() => assertCompliance(pack(), "GDPR")).toThrow(/legal determination/);
    expect(() => controlPack({ package: "x", artifact: "b".repeat(64), controls: [{ id: "C", title: "GDPR compliant", sources: [], applicability: { fact: "", applies: true }, state: "unknown" }] })).toThrow(/compliance claim/);
    expect(() => controlPack({ package: "x", artifact: "b".repeat(64), controls: [{ id: "C", title: "attested thing", sources: [], applicability: { fact: "", applies: true }, state: "attested", evidence: { ref: "r", at: "2026-01-01T00:00:00Z" } }] })).toThrow(/who attested/);
    const report = evidenceReport(pack(), now);
    expect(report.assumptions).toEqual(["TC-RESTORE-DRILL: drill covered the production region only"]);
    expect(report.reviewRequired).toEqual(["TC-RESTORE-DRILL"]);
    expect(report.stale).toEqual(["TC-SUPPRESSION"]);
    expect(report.unknown).toEqual(["TC-VENDOR-ERASURE"]);
    expect(report.disclaimer).toMatch(/never claims GDPR, FERPA, COPPA/);
    expect(JSON.stringify(report)).not.toMatch(/compliant/i);
  });

  it("OSCAL export is bounded to a component definition with implemented requirements and evidence links", () => {
    const oscal = exportOscal(pack(), now) as { "component-definition": { metadata: { remarks: string }; components: { "control-implementations": { "implemented-requirements": { "control-id": string; props: { name: string; value: string }[]; links?: { href: string }[] }[] }[] }[] } };
    const cd = oscal["component-definition"];
    expect(Object.keys(oscal)).toEqual(["component-definition"]);
    expect(cd.metadata.remarks).toMatch(/never claims/);
    const reqs = cd.components[0]!["control-implementations"][0]!["implemented-requirements"];
    expect(reqs.map((r) => r["control-id"])).toEqual(["TC-ERASURE", "TC-SUPPRESSION", "TC-RESTORE-DRILL", "TC-VENDOR-ERASURE"]);
    expect(reqs[1]!.props.find((p) => p.name === "stale")!.value).toBe("true");
    expect(reqs[0]!.links![0]!.href).toBe("vitest:rights.test.ts#PAR-156");
    expect(reqs[3]!.links).toBeUndefined();
  });
});
