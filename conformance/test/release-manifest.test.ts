import { certificationIdentity } from "../../scripts/certification-identity.mjs";
import { readFileSync } from "node:fs";
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

it("rejects malformed dates, empty live evidence and unbound local results", () => {
  const build = JSON.parse(readFileSync(resolve(root, "conformance/fixtures/acme.app.json"), "utf8")).buildHash;
  for (const at of ["invalid", "2028-01-01T00:00:00Z"]) {
    const manifest = buildManifest({ root, now: "2026-10-01T00:00:00Z", certification: { certified: true, buildHash: build, at, targets: { "cloudflare-d1": { scenarios: { ok: true, count: 15, steps: 221 }, realtime: true } } } });
    expect((manifest.combinations as any[]).find(c => c.profile === "cloudflare-d1").status).toBe("unverified");
  }
  const manifest = buildManifest({ root, now: "2026-10-01T00:00:00Z", differential: { drift: "none", profiles: [{ name: "runtime-memory", ran: true, failures: 0 }] } });
  expect((manifest.combinations as any[]).find(c => c.profile === "runtime-memory")).toMatchObject({ status: "unverified", reason: expect.any(String) });
});

it("records the locked CDK version from its development dependency", () => {
  const manifest = buildManifest({ root });
  expect((manifest.pins as any).iac.cdk).toBe("2.270.0");
});

it("accepts complete current differential evidence and rejects each stale or partial binding", () => {
  const identity = certificationIdentity(root);
  const now = "2026-10-01T00:00:00Z";
  const evidence = {
    ...identity, at: now, drift: "none", suitePassed: true,
    profiles: ["runtime-memory", "sqlite-node", "node-postgres"].map(name => ({ name, ran: true, failures: 0, scenarios: identity.scenarioIds.length })),
    pairs: [{ a: "runtime-memory", b: "sqlite-node", compared: 221, unexplained: 0 }, { a: "runtime-memory", b: "node-postgres", compared: 221, unexplained: 0 }],
  };
  const profiles = (d: typeof evidence) => (buildManifest({ root, now, differential: d }).combinations as { profile: string; status: string }[]).filter(c => ["runtime-memory", "sqlite-node", "node-postgres"].includes(c.profile));
  expect(profiles(evidence).every(c => c.status === "certified")).toBe(true);
  for (const patch of [{ suitePassed: false }, { buildHash: "0".repeat(64) }, { sourceFingerprint: "0".repeat(64) }, { node: "v0" }, { at: "invalid" }, { at: "2026-01-01T00:00:00Z" }, { at: "2027-01-01T00:00:00Z" }, { scenarioIds: [] }, { pairs: [] }]) {
    expect(profiles({ ...evidence, ...patch }).every(c => c.status === "unverified")).toBe(true);
  }
  expect(profiles({ ...evidence, profiles: evidence.profiles.map(p => ({ ...p, scenarios: 0 })) }).every(c => c.status === "unverified")).toBe(true);
});


it("does not certify comparisons with missing participants or advertise unrelated local coverage", () => {
  const identity = certificationIdentity(root);
  const evidence = { ...identity, at: "2026-10-01T00:00:00Z", suitePassed: true, drift: "none",
    profiles: [{ name: "node-postgres", ran: true, failures: 0, scenarios: identity.scenarioIds.length }],
    pairs: [{ a: "node-postgres", b: "missing", compared: 221, unexplained: 0 }] };
  const manifest = buildManifest({ root, now: evidence.at, differential: evidence });
  const pg = (manifest.combinations as any[]).find(c => c.profile === "node-postgres");
  expect(pg.status).toBe("unverified");
  expect(pg.features).not.toContain("realtime");
  expect(pg.features).not.toContain("durable restart (PAR-153)");
  expect(pg.evidence).toHaveLength(1);
});

it("rejects incomplete live scenario coverage even with current identity", () => {
  const identity = certificationIdentity(root);
  for (const count of [0, identity.scenarioIds.length - 1]) {
    const manifest = buildManifest({ root, now: "2026-10-01T00:00:00Z", certification: {
      ...identity, at: "2026-10-01T00:00:00Z", certified: true,
      targets: { "cloudflare-d1": { scenarios: { ok: true, count, steps: 221 }, realtime: true } },
    } });
    expect((manifest.combinations as any[]).find(c => c.profile === "cloudflare-d1").status).toBe("unverified");
  }
});
