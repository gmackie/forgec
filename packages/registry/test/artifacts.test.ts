/**
 * FORGE-057 / PAR-124, PAR-125: immutable, content-addressed publication.
 * A locked digest is what resolution uses; a re-pointed tag cannot substitute
 * silently. Tampered IR or an untrusted signature is never activated.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppBundle } from "@forgegraph/runtime";
import { FileArtifactStore, MemoryArtifactStore, Registry, generateSigner, type ArtifactStore, type TrustPolicy } from "../src/artifacts.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const payments = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;

async function setup(store: ArtifactStore = new MemoryArtifactStore()) {
  const signer = await generateSigner("acme-release");
  const trust: TrustPolicy = { authority: "registry.acme", signers: { "acme-release": signer.publicKey } };
  const registry = new Registry({ authority: "registry.acme", store, trust });
  return { signer, trust, registry };
}

describe("PAR-124: a digest pin defeats a mutable tag", () => {
  it("publishes immutable artifacts, tags are mutable pointers, and a lock resolves by digest only", async () => {
    const { registry, signer } = await setup();
    const v1 = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle, provenance: { builder: "ci", commit: "aaa", built_at: "2026-09-20T00:00:00Z" }, signer });
    expect(v1.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // re-publishing the same content yields the same digest (content-addressed)
    const again = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle, provenance: { builder: "ci", commit: "aaa", built_at: "2026-09-20T00:00:00Z" }, signer });
    expect(again.digest).toBe(v1.digest);
    // a "hotfix" re-points the tag at different content
    const changed = { ...bundle, buildHash: "0".repeat(64) };
    const v1b = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle: changed, provenance: { builder: "laptop", commit: "bbb", built_at: "2026-09-21T00:00:00Z" }, signer, retag: true });
    expect(v1b.digest).not.toBe(v1.digest);
    expect((await registry.resolveTag("@acme/commerce", "0.1.0")).digest).toBe(v1b.digest);
    // the lock names the original digest: that is what a locked build gets
    const lock = { dependencies: [{ name: "@acme/commerce", version: "0.1.0", hash: v1.digest }] };
    const pulled = await registry.pullLocked(lock.dependencies[0]!);
    expect(pulled.digest).toBe(v1.digest);
    expect(pulled.bundle.buildHash).toBe(bundle.buildHash);
    // and if the locked digest is gone from the store, resolution fails rather than following the tag
    const empty = await setup();
    await empty.registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle: changed, provenance: { builder: "x", commit: "c", built_at: "2026-09-21T00:00:00Z" }, signer: empty.signer });
    await expect(empty.registry.pullLocked(lock.dependencies[0]!)).rejects.toThrow(/locked digest .* is not available/);
  });

  it("the file store lays artifacts out content-addressed and works as an offline cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-registry-"));
    const store = new FileArtifactStore(dir);
    const { registry, signer, trust } = await setup(store);
    const pub = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle, provenance: { builder: "ci", commit: "aaa", built_at: "2026-09-20T00:00:00Z" }, signer });
    expect(readFileSync(join(dir, "blobs", "sha256", pub.digest.slice(7)), "utf8")).toContain('"manifest/1"');
    // a second registry instance over the same directory (offline) resolves without any publisher present
    const offline = new Registry({ authority: "registry.acme", store: new FileArtifactStore(dir), trust });
    expect((await offline.pullLocked({ name: "@acme/commerce", version: "0.1.0", hash: pub.digest })).bundle.ir.package.name).toBe("@acme/commerce");
    // workspace/path dependencies bypass the registry entirely and are never signed by it
    const ws = await offline.pullLocked({ name: "@acme/payments", version: "0.1.0", hash: "sha256:" + "1".repeat(64), path: resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json") });
    expect(ws.source).toBe("path");
  });
});

describe("PAR-125: artifact signature and schema verification", () => {
  it("tampered IR fails the digest, an untrusted signer fails trust, an unknown critical feature fails schema", async () => {
    const { registry, signer, trust } = await setup();
    const pub = await registry.publish({ name: "@acme/commerce", version: "0.1.0", bundle, provenance: { builder: "ci", commit: "aaa", built_at: "2026-09-20T00:00:00Z" }, signer });
    // tamper the stored blob: the manifest digest no longer matches its content
    const store = registry.store as MemoryArtifactStore;
    const blob = store.blobs.get(pub.layers["ir"]!)!;
    store.blobs.set(pub.layers["ir"]!, blob.replace("@acme/commerce", "@evil/commerce"));
    await expect(registry.pull(pub.digest)).rejects.toThrow(/digest mismatch/);
    // an artifact signed by a key the trust policy does not know is refused, even with intact content
    const rogue = await generateSigner("rogue");
    const other = new Registry({ authority: "registry.acme", store: new MemoryArtifactStore(), trust });
    await expect(other.publish({ name: "@acme/commerce", version: "0.1.0", bundle, provenance: { builder: "x", commit: "y", built_at: "2026-09-20T00:00:00Z" }, signer: rogue })).resolves.toBeTruthy();
    await expect(other.resolveTag("@acme/commerce", "0.1.0")).rejects.toThrow(/signer rogue is not trusted/);
    // an artifact whose IR requires a feature this toolchain does not know is refused before activation
    const future = { ...bundle, ir: { ...bundle.ir, requires: ["time-travel/9"] } };
    const fut = await registry.publish({ name: "@acme/future", version: "9.0.0", bundle: future, provenance: { builder: "ci", commit: "f", built_at: "2026-09-20T00:00:00Z" }, signer });
    await expect(registry.pull(fut.digest)).rejects.toThrow(/unknown critical feature time-travel\/9/);
    // a manifest that was signed under a different authority does not verify here
    const foreign = new Registry({ authority: "registry.other", store: new MemoryArtifactStore(), trust: { ...trust, authority: "registry.other" } });
    const fp = await foreign.publish({ name: "@acme/commerce", version: "0.1.0", bundle: payments, provenance: { builder: "ci", commit: "aaa", built_at: "2026-09-20T00:00:00Z" }, signer });
    (registry.store as MemoryArtifactStore).blobs.set(fp.digest, (foreign.store as MemoryArtifactStore).blobs.get(fp.digest)!);
    for (const [k, v] of (foreign.store as MemoryArtifactStore).blobs) (registry.store as MemoryArtifactStore).blobs.set(k, v);
    await expect(registry.pull(fp.digest)).rejects.toThrow(/authority/);
  });
});
