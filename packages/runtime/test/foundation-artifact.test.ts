import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { D1Storage } from "../src/adapters/d1.js";
import type { SqlExecutor, SqlStatement } from "../src/adapters/sql-executor.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { testLayer } from "../src/testing.js";
import { MemoryObjectStore } from "../src/adapters/memory-objects.js";
import { localAuthorizer } from "../src/gatekeeper.js";
import { Artifacts } from "../src/foundation/artifact.js";
const fixture = process.env["FORGE_FOUNDATION_FIXTURE"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/artifact");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/artifact/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "artifact" };
for (const adapter of ["memory", "sqlite"]) it(`${adapter}: immutable artifact publication and governed downloads`, async () => {
  const model = new Model(bundle);
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(fixture, "d1/0001_init.sql"), "utf8"));
  const run = (s: SqlStatement) => ({ changes: Number(db.prepare(s.sql).run(...s.params as SQLInputValue[]).changes) });
  const executor: SqlExecutor = {
    facade: "sqlite-test",
    first: async <T>(s: SqlStatement) => (db.prepare(s.sql).get(...s.params as SQLInputValue[]) ?? null) as T | null,
    all: async <T>(s: SqlStatement) => db.prepare(s.sql).all(...s.params as SQLInputValue[]) as T[],
    run: async s => run(s),
    batch: async statements => {
      db.exec("BEGIN");
      try { const results = statements.map(run); db.exec("COMMIT"); return results; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  try {
  const objects = new MemoryObjectStore();
  const engine = new Engine(model, testLayer(adapter === "memory" ? new MemoryStorage() : new D1Storage(executor, model), { objects }));
  const call = (op: string, input: Record<string, unknown>, context = ctx) => Effect.runPromise(engine.call(prefix + op, input, context));
  const service = new Artifacts(engine);
  const run = Effect.runPromise;
  const artifact = await call("Artifact.create", { key: "build", label: "Build output" });
  const content = await call("ArtifactContent.create", {});
  await expect(run(service.publish({ artifact: String(artifact.id), content: String(content.id), digest: "sha256:" + "a".repeat(64) }, ctx))).rejects.toThrow();
  const upload = await call("ArtifactContent.beginUpload", { id: content.id, expectedVersion: 1, mediaType: "application/octet-stream", byteCount: 5 });
  await objects.simulateUpload((upload.upload as { url: string }).url, new TextEncoder().encode("hello"), "application/octet-stream");
  const sealed = await call("ArtifactContent.finalizeUpload", { id: content.id, expectedVersion: 2 });
  await expect(run(service.publish({ artifact: String(artifact.id), content: String(content.id), digest: "sha256:" + "b".repeat(64) }, ctx))).rejects.toThrow();
  await expect(call("ArtifactRevision.create", { artifact: artifact.id, content: content.id, digest: sealed.digest, byteCount: 6, mediaType: "application/octet-stream" })).rejects.toThrow();
  const revision = await run(service.publish({ artifact: String(artifact.id), content: String(content.id), digest: String(sealed.digest) }, { ...ctx, idempotencyKey: "publish" }));
  expect(await run(service.publish({ artifact: String(artifact.id), content: String(content.id), digest: String(sealed.digest) }, { ...ctx, idempotencyKey: "publish" }))).toEqual(revision);
  await expect(call("ArtifactContent.beginUpload", { id: content.id, expectedVersion: 3, mediaType: "application/octet-stream", byteCount: 5 })).rejects.toThrow();
  for (const resource of ["ArtifactContent", "ArtifactRevision"]) for (const op of ["delete", "update"]) await expect(call(`${resource}.${op}`, { id: resource === "ArtifactContent" ? content.id : revision.id, expectedVersion: 3, patch: {} })).rejects.toThrow();
  await expect(run(service.download(String(revision.id), ctx))).rejects.toMatchObject({ code: "InspectionPending" });
  await call("admin.inspect", { resource: prefix + "ArtifactContent", id: content.id, digest: sealed.digest, verdict: "allowed", detector: "test-inspector" });
  const download = await run(service.download(String(revision.id), ctx));
  expect(new TextDecoder().decode(await objects.simulateDownload(String(download.url)))).toBe("hello");
  const empty = await call("ArtifactContent.create", {});
  const emptyUpload = await call("ArtifactContent.beginUpload", { id: empty.id, expectedVersion: 1, mediaType: "application/octet-stream", byteCount: 0 });
  await objects.simulateUpload((emptyUpload.upload as { url: string }).url, new Uint8Array(), "application/octet-stream");
  const emptySealed = await call("ArtifactContent.finalizeUpload", { id: empty.id, expectedVersion: 2 });
  const emptyRevision = await run(service.publish({ artifact: String(artifact.id), content: String(empty.id), digest: String(emptySealed.digest) }, ctx));
  expect(emptyRevision.byteCount).toBe(0);
  engine.gatekeeper.authorizer = localAuthorizer({ policies: [], pips: [], epoch: 1, knownObligations: [] });
  await expect(call("ArtifactContent.download", { id: content.id })).rejects.toMatchObject({ code: "NotFound" });
  await expect(run(service.download(String(revision.id), ctx))).rejects.toMatchObject({ code: "NotFound" });
  } finally { db.close(); }
});
