/**
 * FORGE-058/059 / PAR-126, PAR-127, PAR-129: the catalog is a derived,
 * rebuildable index over immutable artifacts; metadata is filtered by
 * namespace/audience on every endpoint; identities are authority-qualified.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forgegraph/runtime";
import { MemoryArtifactStore, Registry, generateSigner } from "../src/artifacts.js";
import { Catalog } from "../src/catalog.js";
import { AccessPolicy, qualifiedId } from "../src/security.js";

const acme = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const next = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme-next.app.json"), "utf8")) as AppBundle;
const edu = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "education.app.json"), "utf8")) as AppBundle;

async function registry(authority = "registry.acme") {
  const signer = await generateSigner("release");
  const r = new Registry({ authority, store: new MemoryArtifactStore(), trust: { authority, signers: { release: signer.publicKey } } });
  const prov = { builder: "ci", commit: "c", built_at: "2026-09-20T00:00:00Z" };
  // dependency versions come from forge.lock at publish time (the IR only names imports)
  const a = await r.publish({ name: "@acme/commerce", version: "0.1.0", bundle: acme, provenance: { ...prov, owner: "team-commerce", dependencies: [{ name: "@acme/payments", version: "0.1.0" }] }, signer });
  const n = await r.publish({ name: "@acme/commerce-next", version: "0.2.0", bundle: next, provenance: { ...prov, owner: "team-commerce" }, signer, audience: ["org:acme"] });
  const e = await r.publish({ name: "@school/education", version: "0.1.0", bundle: edu, provenance: { ...prov, owner: "team-school" }, signer, audience: ["org:school"] });
  return { r, signer, a, n, e };
}

describe("PAR-126: the catalog is rebuildable and idempotent", () => {
  it("reindexing the same digests twice yields one entry per semantic version and identical search results", async () => {
    const { r, a } = await registry();
    const catalog = new Catalog({ authority: "registry.acme" });
    await catalog.index(await r.pull(a.digest));
    const first = catalog.snapshot();
    await catalog.index(await r.pull(a.digest));
    await catalog.index(await r.pull(a.digest));
    expect(catalog.snapshot()).toEqual(first);
    expect(catalog.packages().filter((p) => p.name === "@acme/commerce" && p.version === "0.1.0")).toHaveLength(1);
    // drop the index and rebuild it from the artifacts alone: same results, package authority unchanged
    const rebuilt = new Catalog({ authority: "registry.acme" });
    await rebuilt.rebuild(r);
    const admin = { subject: "ops", namespaces: ["*"], audiences: ["*"] };
    expect(rebuilt.search("Customer", admin).filter((h) => h.package === "registry.acme/@acme/commerce@0.1.0")).toEqual(catalog.search("Customer", admin));
    expect(catalog.search("Customer", admin).length).toBeGreaterThan(3);
    expect(rebuilt.schemaVersion).toBe(catalog.schemaVersion);
    // the index records exports, fields with classes, subjects, purposes, actions, effects, owners and dependencies
    const hit = rebuilt.search("Order", admin).find((h) => h.kind === "resource" && h.name === "Order" && h.package.includes("@acme/commerce@"))!;
    expect(hit.package).toBe("registry.acme/@acme/commerce@0.1.0");
    expect(hit.owner).toBe("team-commerce");
    expect(rebuilt.graph("registry.acme/@acme/commerce@0.1.0", admin)!.dependencies).toEqual(["@acme/payments@0.1.0"]);
    const actions = rebuilt.actions("registry.acme/@acme/commerce@0.1.0", admin).map((x) => x.id);
    expect(actions).toContain("@acme/commerce/_/Order.status.approve");
    expect(actions).toContain("@acme/commerce/_/SubmitOrder");
  });
});

describe("PAR-127: catalog metadata confidentiality", () => {
  it("a principal outside the audience sees no names, neighbors or action schemas through any endpoint", async () => {
    const { r } = await registry();
    const catalog = new Catalog({ authority: "registry.acme" });
    await catalog.rebuild(r);
    const outsider = { subject: "vendor", namespaces: ["@acme/*"], audiences: ["org:vendor"] };
    const insider = { subject: "acme-dev", namespaces: ["@acme/*"], audiences: ["org:acme"] };
    // the public package is visible to both; the audience-restricted package only to the insider
    expect(new Set(catalog.search("Customer", outsider).map((h) => h.package))).toEqual(new Set(["registry.acme/@acme/commerce@0.1.0"]));
    expect(new Set(catalog.search("Customer", insider).map((h) => h.package))).toEqual(new Set(["registry.acme/@acme/commerce@0.1.0", "registry.acme/@acme/commerce-next@0.2.0"]));
    // sensitive purpose and data-class names never leak: search, graph, actions, packages, fields
    const sensitive = ["CustomerSupport", "ParentCommunication", "SupportRecord", "supportNotes"];
    for (const term of sensitive) {
      expect(catalog.search(term, outsider)).toEqual([]);
      expect(catalog.search(term, insider).length).toBeGreaterThan(0);
    }
    expect(catalog.graph("registry.acme/@acme/commerce-next@0.2.0", outsider)).toBeNull();
    expect(catalog.actions("registry.acme/@acme/commerce-next@0.2.0", outsider)).toEqual([]);
    expect(catalog.packages(outsider).map((p) => p.name)).toEqual(["@acme/commerce"]);
    expect(JSON.stringify(catalog.fields("registry.acme/@acme/commerce-next@0.2.0", outsider))).not.toMatch(/supportNotes|ParentCommunication/);
    // namespace scoping: the school namespace is invisible to an acme-only principal even with a matching audience
    const school = { subject: "teacher", namespaces: ["@school/*"], audiences: ["org:school"] };
    expect(catalog.packages(school).map((p) => p.name)).toEqual(["@school/education"]);
    expect(catalog.packages({ ...insider, audiences: ["org:acme", "org:school"] }).map((p) => p.name)).not.toContain("@school/education");
    // the policy object itself is deterministic and explains a refusal without naming what was hidden
    const why = new AccessPolicy().explain(outsider, { namespace: "@acme/commerce-next", audience: ["org:acme"] });
    expect(why).toEqual({ allowed: false, reason: "audience" });
  });
});

describe("PAR-129: federated identities do not collide", () => {
  it("the same name/version from two authorities are distinct, and a grant on one is not a grant on the other", async () => {
    const a = await registry("registry.acme");
    const b = await registry("registry.mirror");
    const catalog = new Catalog({ authority: "registry.acme" });
    await catalog.rebuild(a.r);
    await catalog.rebuild(b.r, { federated: { authority: "registry.mirror", trust: b.r.trust } });
    const admin = { subject: "ops", namespaces: ["*"], audiences: ["*"] };
    const ids = catalog.packages(admin).filter((p) => p.name === "@acme/commerce").map((p) => p.id).sort();
    expect(ids).toEqual(["registry.acme/@acme/commerce@0.1.0", "registry.mirror/@acme/commerce@0.1.0"]);
    expect(qualifiedId("registry.acme", "@acme/commerce", "0.1.0")).toBe("registry.acme/@acme/commerce@0.1.0");
    // grants are keyed by the qualified identity
    const policy = new AccessPolicy();
    policy.grant("registry.acme/@acme/commerce@0.1.0", { subject: "partner", capability: "use" });
    expect(policy.granted("registry.acme/@acme/commerce@0.1.0", "partner", "use")).toBe(true);
    expect(policy.granted("registry.mirror/@acme/commerce@0.1.0", "partner", "use")).toBe(false);
    // a mirror whose trust policy is not accepted cannot be indexed at all
    const untrusted = new Catalog({ authority: "registry.acme" });
    await expect(untrusted.rebuild(b.r, { federated: { authority: "registry.mirror", trust: { authority: "registry.mirror", signers: {} } } })).rejects.toThrow(/not trusted/);
  });
});
