/** FORGE-091 / PAR-176, PAR-179: the release manifest is honest about scope. */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../scripts/release-manifest.js";

const root = resolve(import.meta.dirname, "..", "..");

describe("release manifest", () => {
  it("PAR-176: a skipped or failed required profile makes allRequiredProfilesCertified false and names it", () => {
    const m = buildManifest({ root, now: "2026-09-21T00:00:00Z", differential: { drift: "none", profiles: [{ name: "runtime-memory", ran: true, failures: 0 }, { name: "sqlite-node", ran: true, failures: 0 }, { name: "node-postgres", ran: false, reason: "FORGE_PG_URL not set", failures: 0 }] } });
    expect(m["allRequiredProfilesCertified"]).toBe(false);
    expect((m["incomplete"] as { requiredNotCertified: string[] }).requiredNotCertified).toContain("node-postgres");
    const pg = (m["combinations"] as { profile: string; status: string; reason?: string }[]).find((c) => c.profile === "node-postgres")!;
    expect(pg).toMatchObject({ status: "unverified", reason: "FORGE_PG_URL not set" });
    const failed = buildManifest({ root, now: "2026-09-21T00:00:00Z", differential: { drift: "unexplained", profiles: [{ name: "runtime-memory", ran: true, failures: 0 }, { name: "sqlite-node", ran: true, failures: 2 }, { name: "node-postgres", ran: true, failures: 0 }] } });
    expect(failed["allRequiredProfilesCertified"]).toBe(false);
    expect((failed["incomplete"] as { requiredNotCertified: string[] }).requiredNotCertified).toEqual(expect.arrayContaining(["sqlite-node", "node-postgres", "runtime-memory"]));
    // a missing live certification leaves the cloud profiles unverified with a reason, never silently certified
    const noClouds = buildManifest({ root, now: "2026-09-21T00:00:00Z", certification: null });
    expect((noClouds["combinations"] as { profile: string; status: string; reason?: string }[]).find((c) => c.profile === "cloudflare-d1")).toMatchObject({ status: "unverified", reason: expect.stringMatching(/no live certification/) });
    // live evidence for another build does not certify this one
    const otherBuild = buildManifest({ root, now: "2026-09-21T00:00:00Z", certification: { certified: true, at: "2026-09-21T00:00:00Z", buildHash: "0".repeat(64), targets: { "cloudflare-d1": { scenarios: { ok: true, count: 15, steps: 221 }, realtime: true }, "aws-dynamodb": { scenarios: { ok: true, count: 15, steps: 221 }, realtime: true } } } });
    expect((otherBuild["combinations"] as { profile: string; status: string; reason?: string }[]).find((c) => c.profile === "aws-dynamodb")).toMatchObject({ status: "unverified", reason: expect.stringMatching(/re-run pnpm certify/) });
    // and stale evidence expires
    const stale = buildManifest({ root, now: "2027-06-01T00:00:00Z" });
    expect((stale["combinations"] as { profile: string; status: string; reason?: string }[]).find((c) => c.profile === "cloudflare-d1")!.status).toBe("unverified");
  });

  it("PAR-179: the manifest from retained artifacts lists exact pins, features, evidence, non-certified combinations and retest rules", () => {
    const m = buildManifest({ root, now: "2026-09-21T00:00:00Z" });
    const pins = m["pins"] as Record<string, Record<string, unknown>>;
    expect(pins["compiler"]!["version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins["compiler"]!["rustVersion"]).toBe("1.97");
    expect(pins["runtime"]!["effect"]).toBe("4.0.0-rc.116");
    expect(pins["interfaces"]!["mcp"]).toEqual(["2025-06-18", "2025-03-26"]);
    expect(pins["governance"]!["taxonomy"]).toBe("data-taxonomy/1");
    expect((pins["iac"] as { terraform: { cloudflare: string } }).terraform.cloudflare).toBe("5.4.0");
    const combos = m["combinations"] as { profile: string; status: string; evidence: unknown[]; features: string[] }[];
    for (const c of combos.filter((x) => x.status === "certified")) expect(c.evidence.length).toBeGreaterThan(0);
    expect(combos.map((c) => c.profile)).toEqual(["cloudflare-d1", "aws-dynamodb", "node-postgres", "sqlite-node", "runtime-memory"]);
    const notCertified = m["notCertified"] as { profile: string; status: string; reason: string | null }[];
    expect(notCertified.map((n) => n.profile)).toEqual(expect.arrayContaining(["neon/direct", "turso/libsql/node/any", "planetscale-mysql/*"]));
    expect(notCertified.map((n) => n.profile)).not.toContain("self-hosted-full (temporal)"); // certified post-release on the single-node topology
    for (const n of notCertified) expect(n.reason).toBeTruthy();
    expect(m["retest"]).toMatchObject({ expiryDays: 90 });
    expect(String(m["disclaimer"])).toMatch(/not a statement of regulatory compliance/);
    expect(JSON.stringify(m)).not.toMatch(/universal|fully compliant/i);
  });
});
