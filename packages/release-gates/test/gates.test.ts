/**
 * FORGE-071 / PAR-147: previews are governed (production classification and
 * retention still apply; restricted data is sanitized, not branched), and
 * promotion needs evidence: an SLO gate with insufficient samples or missing
 * metrics never passes, acknowledgments are signed and bound to the artifact,
 * and cleanup defaults to retain.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forge/runtime";
import { previewProfile, sanitize, sloGate, acknowledge, verifyAcknowledgment, cleanupPolicy } from "../src/index.js";

const next = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("governed previews", () => {
  it("a preview sourced from production keeps production classification: restricted fields are sanitized, never branched as-is", () => {
    const profile = previewProfile(next, { name: "pr-42", source: "production", ttlHours: 72 });
    expect(profile.isolation).toBe("isolated");
    expect(profile.retention).toEqual({ ttlHours: 72, onExpiry: "retain-then-review" });
    // fields carrying personal data are listed with the treatment applied to them
    const treated = Object.fromEntries(profile.fields.map((f) => [`${f.resource.slice(f.resource.lastIndexOf("/_/") + 3)}.${f.field}`, f.treatment]));
    expect(treated["Contact.email"]).toBe("pseudonymize");
    expect(treated["Contact.supportNotes"]).toBe("redact");
    expect(treated["Contact.name"]).toBe("redact"); // unclassified restricted content on a person resource
    expect(treated["Customer.code"]).toBe("pseudonymize"); // restricted but not a subject: keep joins/uniqueness
    expect(treated["Contact.id"]).toBe("keep");
    // sanitize applies the profile to a record: same shape, no restricted content, deterministic pseudonyms
    const rec = { id: "con_1", customer: "cus_1", name: "Pat Example", email: "pat@example.com", supportNotes: "called about invoice 77" };
    const a = sanitize(profile, "@acme/commerce-next/_/Contact", rec);
    const b = sanitize(profile, "@acme/commerce-next/_/Contact", rec);
    expect(a).toEqual(b);
    expect(a["id"]).toBe("con_1");
    expect(a["email"]).not.toBe("pat@example.com");
    expect(String(a["email"])).toMatch(/@preview\.invalid$/);
    expect(a["supportNotes"]).toBe("[redacted]");
    expect(a["name"]).toBe("[redacted]");
    // a synthetic-source preview has nothing to sanitize but the same isolation and retention rules
    const synthetic = previewProfile(next, { name: "pr-43", source: "synthetic", ttlHours: 24 });
    expect(synthetic.fields.every((f) => f.treatment === "keep")).toBe(true);
    expect(synthetic.isolation).toBe("isolated");
    // database branching of production is refused as a preview source
    expect(() => previewProfile(next, { name: "pr-44", source: "branch", ttlHours: 1 } as never)).toThrow(/branch/);
  });

  it("cleanup defaults to retain and never deletes on expiry without a recorded decision", () => {
    const policy = cleanupPolicy({ ttlHours: 24 });
    expect(policy).toEqual({ ttlHours: 24, onExpiry: "retain-then-review", deleteRequires: "recorded decision by the owner" });
    expect(cleanupPolicy({ ttlHours: 24, onExpiry: "delete", decision: { by: "owner", at: "2026-09-21T00:00:00Z", reason: "throwaway" } }).onExpiry).toBe("delete");
    expect(() => cleanupPolicy({ ttlHours: 24, onExpiry: "delete" } as never)).toThrow(/decision/);
  });
});

describe("PAR-147: SLO gate evidence", () => {
  const targets = { availability: 0.999, latencyP99Ms: 1000, minSamples: 500, windowMinutes: 30 };
  it("insufficient traffic or missing metrics never pass; enough evidence within targets passes; a breach fails", () => {
    const thin = sloGate(targets, { samples: 120, errors: 0, latencyP99Ms: 300, windowMinutes: 30 });
    expect(thin).toMatchObject({ verdict: "insufficient-evidence", reason: expect.stringMatching(/120 of 500/) });
    const missing = sloGate(targets, { samples: 900, errors: 1, windowMinutes: 30 });
    expect(missing).toMatchObject({ verdict: "insufficient-evidence", reason: expect.stringMatching(/latencyP99Ms/) });
    const shortWindow = sloGate(targets, { samples: 900, errors: 1, latencyP99Ms: 300, windowMinutes: 5 });
    expect(shortWindow.verdict).toBe("insufficient-evidence");
    const pass = sloGate(targets, { samples: 900, errors: 0, latencyP99Ms: 800, windowMinutes: 30 });
    expect(pass).toMatchObject({ verdict: "pass", observed: { availability: 1, latencyP99Ms: 800, samples: 900 } });
    const fail = sloGate(targets, { samples: 900, errors: 5, latencyP99Ms: 800, windowMinutes: 30 });
    expect(fail).toMatchObject({ verdict: "fail", reason: expect.stringMatching(/availability/) });
    // an insufficient verdict is not a pass for promotion, whatever the human wants
    expect(thin.promotable).toBe(false);
    expect(pass.promotable).toBe(true);
  });

  it("acknowledgments are signed and bound to the artifact and the gate result they approve", async () => {
    const gate = sloGate(targets, { samples: 900, errors: 0, latencyP99Ms: 800, windowMinutes: 30 });
    const ack = await acknowledge({ artifact: acme.buildHash, stage: "traffic-25", gate, by: "release-manager" }, "shared-secret");
    expect(ack.artifact).toBe(acme.buildHash);
    expect(await verifyAcknowledgment(ack, "shared-secret")).toBe(true);
    expect(await verifyAcknowledgment({ ...ack, artifact: "0".repeat(64) }, "shared-secret")).toBe(false);
    expect(await verifyAcknowledgment(ack, "other-secret")).toBe(false);
    // an acknowledgment cannot be minted over an insufficient gate
    const thin = sloGate(targets, { samples: 10, errors: 0, latencyP99Ms: 100, windowMinutes: 30 });
    await expect(acknowledge({ artifact: acme.buildHash, stage: "traffic-25", gate: thin, by: "release-manager" }, "shared-secret")).rejects.toThrow(/insufficient/);
  });
});
