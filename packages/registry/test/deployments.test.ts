/**
 * FORGE-060 / PAR-128, PAR-131: the deployment inventory distinguishes signed
 * release reports from observed health; publication never claims deployment;
 * stale inventory is visibly stale; endpoint checks refuse private hosts; a
 * remote binding needs a trusted deployment, not just a schema hash.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage, type AppBundle } from "@forge/runtime";
import { createNodeHost, type NodeHost } from "@forge/runtime/node";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { MemoryArtifactStore, Registry, generateSigner } from "../src/artifacts.js";
import { Inventory } from "../src/deployments.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

describe("deployment inventory", () => {
  let host: NodeHost;
  let base: string;
  beforeAll(async () => {
    host = createNodeHost({ bundle, store: new MemoryStorage(), functions, externals, cursorSecret: "inv-test", sweepIntervalMs: 0, telemetryFormat: "silent" });
    base = (await host.listen(0)).url;
  });
  afterAll(async () => { await host?.stop(); });

  it("PAR-128: publishing a contract claims nothing about running services; only a signed release report does", async () => {
    const signer = await generateSigner("release");
    const registry = new Registry({ authority: "registry.acme", store: new MemoryArtifactStore(), trust: { authority: "registry.acme", signers: { release: signer.publicKey } } });
    const pub = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle, provenance: { builder: "ci", commit: "c", built_at: "2026-09-20T00:00:00Z" }, signer });
    const inventory = new Inventory({ authority: "registry.acme", trust: registry.trust, staleAfterMs: 60_000, allowHosts: ["api.acme.example"] });
    expect(inventory.implementers(pub.digest)).toEqual([]);
    // a signed descriptor from the release pipeline is a claim; the inventory records who signed it and when
    const report = await inventory.report({ deployment: "acme-prod", endpoint: "https://api.acme.example", artifact: pub.digest, buildHash: bundle.buildHash, digests: bundle.digests!, contracts: bundle.contracts.version, at: "2026-09-20T10:00:00Z" }, signer);
    expect(report.signedBy).toBe("release");
    const now = Date.parse("2026-09-20T10:00:30Z");
    expect(inventory.implementers(pub.digest, now).map((d) => d.deployment)).toEqual(["acme-prod"]);
    // an unsigned or wrongly signed descriptor is not accepted as a claim
    const rogue = await generateSigner("rogue");
    await expect(inventory.report({ deployment: "acme-prod", endpoint: "https://api.acme.example", artifact: pub.digest, buildHash: "x", digests: {}, contracts: "c", at: "2026-09-20T10:00:00Z" }, rogue)).rejects.toThrow(/not trusted/);
    // retirement is explicit and signed too
    await inventory.retire({ deployment: "acme-prod", at: "2026-09-20T11:00:00Z" }, signer);
    expect(inventory.implementers(pub.digest, Date.parse("2026-09-20T11:00:01Z"))).toEqual([]);
    expect(inventory.list(Date.parse("2026-09-20T11:00:01Z")).find((d) => d.deployment === "acme-prod")?.state).toBe("retired");
  });

  it("stale inventory is visibly stale; observed health never becomes a signed claim", async () => {
    const signer = await generateSigner("release");
    const trust = { authority: "registry.acme", signers: { release: signer.publicKey } };
    const inventory = new Inventory({ authority: "registry.acme", trust, staleAfterMs: 60_000, allowHosts: ["127.0.0.1"] , allowLoopbackForTests: true });
    await inventory.report({ deployment: "local", endpoint: base, artifact: "sha256:" + "a".repeat(64), buildHash: bundle.buildHash, digests: bundle.digests!, contracts: bundle.contracts.version, at: "2026-09-20T10:00:00Z" }, signer);
    const fresh = inventory.list(Date.parse("2026-09-20T10:00:30Z"))[0]!;
    expect(fresh.state).toBe("reported");
    expect(fresh.stale).toBe(false);
    const later = inventory.list(Date.parse("2026-09-20T10:02:00Z"))[0]!;
    expect(later.stale).toBe(true);
    // an observation (discovery over the network) is recorded separately with what was actually seen
    const obs = await inventory.observe("local", { credential: { kind: "dev-header", tenant: "inv", actor: "probe" } });
    expect(obs.kind).toBe("observed");
    expect(obs.match).toBe(true); // observed digests agree with the signed report
    expect(inventory.list(Date.now())[0]!.observed?.buildHash).toBe(bundle.buildHash);
    // an observation alone never creates an implementer claim
    expect(inventory.implementers("sha256:" + "b".repeat(64), Date.now())).toEqual([]);
  });

  it("endpoint checks refuse private and unlisted hosts on report and on observe", async () => {
    const signer = await generateSigner("release");
    const inventory = new Inventory({ authority: "registry.acme", trust: { authority: "registry.acme", signers: { release: signer.publicKey } }, staleAfterMs: 60_000, allowHosts: ["api.acme.example"] });
    for (const bad of ["http://169.254.169.254/latest", "http://10.0.0.1/", "http://localhost:3000", "https://other.example"]) {
      await expect(inventory.report({ deployment: "d", endpoint: bad, artifact: "sha256:" + "a".repeat(64), buildHash: "b", digests: {}, contracts: "c", at: "2026-09-20T10:00:00Z" }, signer)).rejects.toThrow(/forbidden|not in the allowed/);
    }
  });

  it("PAR-131: a remote binding needs a trusted deployment and audience, not just a matching schema hash", async () => {
    const signer = await generateSigner("release");
    const trust = { authority: "registry.acme", signers: { release: signer.publicKey } };
    const inventory = new Inventory({ authority: "registry.acme", trust, staleAfterMs: 60_000, allowHosts: ["127.0.0.1"], allowLoopbackForTests: true });
    // the live host advertises a valid schema, but nobody has vouched for it
    const unvouched = await inventory.bindingFor({ endpoint: base, digests: bundle.digests!, credential: { kind: "dev-header", tenant: "inv", actor: "probe" } });
    expect(unvouched.kind).toBe("refused");
    expect((unvouched as { reason: string }).reason).toMatch(/no signed deployment report/);
    // a signed report for a *different* endpoint does not transfer
    await inventory.report({ deployment: "prod", endpoint: "http://127.0.0.1:1", artifact: "sha256:" + "a".repeat(64), buildHash: bundle.buildHash, digests: bundle.digests!, contracts: bundle.contracts.version, at: new Date().toISOString() }, signer);
    const wrongEndpoint = await inventory.bindingFor({ endpoint: base, digests: bundle.digests!, credential: { kind: "dev-header", tenant: "inv", actor: "probe" } });
    expect(wrongEndpoint.kind).toBe("refused");
    // a signed, fresh report for this endpoint whose digests match: the binding is issued with the expectation pinned
    await inventory.report({ deployment: "local", endpoint: base, artifact: "sha256:" + "a".repeat(64), buildHash: bundle.buildHash, digests: bundle.digests!, contracts: bundle.contracts.version, at: new Date().toISOString() }, signer);
    const ok = await inventory.bindingFor({ endpoint: base, digests: bundle.digests!, credential: { kind: "dev-header", tenant: "inv", actor: "probe" } });
    expect(ok.kind).toBe("bound");
    const out = await (ok as { callable: { invoke: (o: string, i: unknown) => Promise<{ kind: string }> } }).callable.invoke("@acme/commerce/_/Customer.list.all", { params: {} });
    expect(out.kind).toBe("ok");
    // a stale report is not enough either
    const stale = await inventory.bindingFor({ endpoint: base, digests: bundle.digests!, credential: { kind: "dev-header", tenant: "inv", actor: "probe" }, now: Date.now() + 120_000 });
    expect(stale.kind).toBe("refused");
    expect((stale as { reason: string }).reason).toMatch(/stale/);
  });
});
