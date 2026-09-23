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
import { resolveSpecificationSelector, resolveSpecificationSourceSpan, type SpecificationProvider } from "../src/foundation/specification.js";
const fixture = process.env["FORGE_FOUNDATION_FIXTURE"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/specification");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/specification/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "specification" };
for (const adapter of ["memory", "sqlite"]) it(`${adapter}: pins reject selectors, edits and deletion; realizations keep hashes distinct`, async () => {
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
  const engine = new Engine(model, testLayer(adapter === "memory" ? new MemoryStorage() : new D1Storage(executor, model)));
  const call = (op: string, body: Record<string, unknown>) => Effect.runPromise(engine.call(prefix + op, body, ctx));
  const repo = await call("Repository.create", { key: "forge", provider: "git", locator: "https://example.test/forge" });
  const input = { repository: repo.id, anchor: "@example/app/_/Order" };
  for (const revision of ["main", "latest", "v1.0", "a".repeat(41), "A".repeat(40)]) await expect(call("SpecificationPin.create", { ...input, revision })).rejects.toThrow();
  const pin = await call("SpecificationPin.create", { ...input, revision: "a".repeat(40) });
  await expect(call("SpecificationPin.create", { ...input, revision: "a".repeat(40) })).rejects.toThrow();
  for (const op of ["update", "delete", "restore", "move"]) await expect(call(`SpecificationPin.${op}`, { id: pin.id, patch: { revision: "b".repeat(40) } })).rejects.toThrow();
  await call("SpecificationPin.create", { ...input, revision: "b".repeat(64) });
  expect(await call("SpecificationPin.get", { id: pin.id })).toMatchObject({ revision: "a".repeat(40) });
  const realization = await call("Realization.create", { pin: pin.id, buildHash: "c".repeat(64), manifestDigest: "sha256:" + "d".repeat(64) });
  expect(realization).toMatchObject({ pin: pin.id, buildHash: "c".repeat(64), manifestDigest: "sha256:" + "d".repeat(64) });
  await expect(call("Realization.delete", { id: realization.id })).rejects.toThrow();
  } finally { db.close(); }
});
it("runtime rejects forged mutation operations on append-only IR", async () => {
  const modified = structuredClone(bundle);
  const pin = modified.ir.modules.flatMap(m => m.resources).find(r => r.name === "SpecificationPin")!;
  pin.operations.push({ id: prefix + "SpecificationPin.delete", kind: "delete" });
  const engine = new Engine(new Model(modified), testLayer(new MemoryStorage()));
  await expect(Effect.runPromise(engine.call(prefix + "SpecificationPin.delete", { id: "any" }, ctx))).rejects.toMatchObject({ code: "MethodNotAllowed", detail: "SpecificationPin is append-only" });
});
it("selector evolution and file movement never change existing pin identity", async () => {
  let revision = "a".repeat(40);
  const oldRevision = revision;
  const provider: SpecificationProvider = {
    resolveSelector: async r => ({ repository: r.repository, anchor: r.anchor, revision }),
    sourceMap: async pin => ({ repository: pin.repository, map: { version: "forge-source-map/1", revision: pin.revision, anchors: { [pin.anchor]: { file: pin.revision === oldRevision ? "src/old.forge" : "src/moved.forge", start: 0, end: 10 } } } }),
  };
  const request = { repository: "repo", anchor: "@app/_/Order", selector: "main" };
  const pin = await resolveSpecificationSelector(provider, request);
  revision = "b".repeat(40);
  const nextPin = await resolveSpecificationSelector(provider, request);
  expect(nextPin.revision).toBe(revision);
  expect(pin.revision).toBe("a".repeat(40));
  expect((await resolveSpecificationSourceSpan(provider, pin)).file).toBe("src/old.forge");
  expect((await resolveSpecificationSourceSpan(provider, nextPin)).file).toBe("src/moved.forge");
  await expect(resolveSpecificationSourceSpan({ ...provider, sourceMap: async p => ({ repository: p.repository, map: { version: "forge-source-map/1", revision, anchors: {} } }) }, pin)).rejects.toThrow("does not match");
  await expect(resolveSpecificationSelector({ ...provider, resolveSelector: async r => ({ ...r, repository: "wrong", revision }) }, request)).rejects.toThrow("substituted");
  revision = "main";
  await expect(resolveSpecificationSelector(provider, request)).rejects.toThrow("Git object ID");
});
