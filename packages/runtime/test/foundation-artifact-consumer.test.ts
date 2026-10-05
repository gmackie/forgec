import { Effect } from "effect";
import { createHash } from "node:crypto";
import { it, expect } from "vitest";
import { consumerFixture, foundationAdapters } from "./foundation-fixture.js";
import { Artifacts } from "../src/foundation/artifact.js";
import { Objects } from "../src/services.js";
import type { MemoryObjectStore } from "../src/adapters/memory-objects.js";
const domain = "@foundation-probe/artifact-consumers/_/", base = "@forgegraph/foundation/artifact/_/", spec = "@forgegraph/foundation/specification/_/";
for (const adapter of foundationAdapters) it(`${adapter}: immutable component manifests, realized provenance and all typed artifact consumers`, async () => {
  const { engine, close } = await consumerFixture("artifact", adapter);
  const ctx = { tenant: "t", actor: "u", requestId: "artifact-fixtures" };
  const call = (op: string, input: Record<string, unknown>) => Effect.runPromise(engine.call(op, input, ctx));
  const run = Effect.runPromise;
  try {
    const objects = await run(Objects.pipe(Effect.provide(engine.layer))) as MemoryObjectStore;
    const service = new Artifacts(engine);
    const repo = await call(spec + "Repository.create", { key: "repo", provider: "git", locator: "local" });
    const pin = await call(spec + "SpecificationPin.create", { repository: repo.id, anchor: "@fixture/_/Spec", revision: "a".repeat(40) });
    const artifact = await call(base + "Artifact.create", { key: "output", label: "Output" });
    const publish = async (text: string, components?: string) => {
      const bytes = new TextEncoder().encode(text), digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
      const content = await call(base + "ArtifactContent.create", {});
      const up = await call(base + "ArtifactContent.beginUpload", { id: content.id, expectedVersion: 1, mediaType: "application/json", byteCount: bytes.length });
      await objects.simulateUpload(up.upload.url, bytes, "application/json");
      await call(base + "ArtifactContent.finalizeUpload", { id: content.id, expectedVersion: 2 });
      const realization = await call(spec + "Realization.create", { pin: pin.id, buildHash: "b".repeat(64), manifestDigest: digest });
      const revision = await run(service.publish({ artifact: artifact.id, content: content.id, digest, specificationPin: pin.id, realization: realization.id, ...(components ? { components } : {}) }, ctx));
      expect(revision.realization).toBe(realization.id);
      return revision;
    };
    const child = await publish('{"file":"asset"}');
    const first = await run(service.component("asset.json", String(child.id), null, ctx));
    const manifest = await publish('{"manifest":1}', String(first.id));
    const next = await run(service.component("another.json", String(child.id), String(first.id), ctx));
    const second = await publish('{"manifest":2}', String(next.id));
    expect(await run(service.components(String(manifest.components), ctx))).toEqual([{ name: "asset.json", revision: child.id }]);
    expect(await run(service.components(String(second.components), ctx))).toHaveLength(2);
    await expect(call(base + "ArtifactComponent.update", { id: first.id, patch: { next: next.id } })).rejects.toThrow();
    await expect(call(base + "ArtifactComponent.delete", { id: first.id })).rejects.toThrow();
    const duplicate = await run(service.component("asset.json", String(child.id), String(first.id), ctx));
    await expect(run(service.components(String(duplicate.id), ctx))).rejects.toThrow();
    const otherPin = await call(spec + "SpecificationPin.create", { repository: repo.id, anchor: "@fixture/_/Spec", revision: "c".repeat(40) });
    await expect(call(base + "ArtifactRevision.create", { artifact: artifact.id, content: child.content, digest: child.digest, mediaType: child.mediaType, byteCount: child.byteCount, specificationPin: otherPin.id, realization: child.realization })).rejects.toMatchObject({ code: "ValidationFailed" });
    for (const [name, fields] of [
      ["BuildOutput", { buildHash: "b".repeat(64) }], ["EvidenceDocument", { observation: "Verified" }], ["GeneratedAsset", { generator: "generator" }], ["Document", { title: "Document" }],
    ] as const) {
      const owner = await call(domain + name + ".create", { revision: manifest.id, ...fields });
      expect((await call(domain + name + ".get", { id: owner.id })).revision).toBe(manifest.id);
    }
    await expect(run(service.components(String(first.id), { ...ctx, tenant: "other" }))).rejects.toThrow();
  } finally { await close(); }
});
