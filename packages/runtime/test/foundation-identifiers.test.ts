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
import { Identifiers } from "../src/foundation/identifiers.js";
const fixture = process.env["FORGE_FOUNDATION_FIXTURE"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/identifiers");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/identifiers/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "identifiers" };
for (const adapter of ["memory", "sqlite"]) it(`${adapter}: qualified uniqueness, immutable history and validity`, async () => {
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
  const call = (op: string, input: Record<string, unknown>, context = ctx) => Effect.runPromise(engine.call(prefix + op, input, context));
  const service = new Identifiers(engine);
  const run = Effect.runPromise;
  const set = await call("IdentifierSet.create", { label: "Device" });
  const otherSet = await call("IdentifierSet.create", { label: "Other device" });
  const issuer = await call("Issuer.create", { key: "manufacturer" });
  const start = "2026-01-01T00:00:00Z", end = "2026-02-01T00:00:00Z";
  const assignment = { identifierSet: String(set.id), namespace: "serial", value: "S001", validFrom: start, validUntil: end };
  const { validUntil: _until, ...openAssignment } = assignment;
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => run(service.assign(assignment, ctx))));
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const old = outcomes.find(r => r.status === "fulfilled")! as PromiseFulfilledResult<Record<string, unknown>>;
  const pin = String(old.value.id);
  expect(await run(service.lookup({ namespace: " SERIAL ", value: " S001 " }, start, ctx))).toEqual({ identifier: pin, identifierSet: set.id });
  expect(await run(service.lookup({ namespace: "serial", value: "S001" }, end, ctx))).toBeNull();
  expect(await run(service.lookup({ namespace: "serial", value: "S001" }, "2025-12-31T23:59:59Z", ctx))).toBeNull();
  await expect(run(service.assign({ ...openAssignment, identifierSet: String(otherSet.id), validFrom: end }, ctx))).rejects.toThrow();
  const issued = await run(service.assign({ ...assignment, issuer: String(issuer.id) }, ctx));
  expect(issued.id).not.toBe(pin);
  await expect(call("Identifier.create", { ...assignment, issuer: issuer.id, issuerScope: "namespace" })).rejects.toThrow();
  const foreign = await run(service.assign({ ...openAssignment, identifierSet: String(otherSet.id), value: "FOREIGN", validFrom: end }, ctx));
  await expect(run(service.supersede(pin, String(foreign.id), end, "Wrong owner", ctx))).rejects.toThrow();
  const replacement = await run(service.assign({ ...openAssignment, value: "S002", validFrom: end }, ctx));
  await run(service.supersede(pin, String(replacement.id), end, "Corrected serial", { ...ctx, idempotencyKey: "supersession" }));
  await run(service.supersede(pin, String(replacement.id), end, "Corrected serial", { ...ctx, idempotencyKey: "supersession" }));
  await expect(run(service.revoke(pin, end, "Conflicting end", ctx))).rejects.toThrow();
  await expect(run(service.supersede(String(replacement.id), pin, end, "Cycle", ctx))).rejects.toThrow();
  const nextDay = "2026-02-02T00:00:00Z";
  await run(service.revoke(String(replacement.id), nextDay, "Retired", ctx));
  expect(await run(service.lookup({ namespace: "serial", value: "S002" }, end, ctx))).toMatchObject({ identifierSet: set.id });
  expect(await run(service.lookup({ namespace: "serial", value: "S002" }, nextDay, ctx))).toBeNull();
  await expect(run(service.assign({ ...openAssignment, value: "S002", validFrom: nextDay }, ctx))).rejects.toThrow();
  for (const resource of ["Identifier", "IdentifierDisposition", "IdentifierSet"]) await expect(call(resource + ".delete", { id: pin })).rejects.toThrow();
  expect(await run(new Identifiers(new Engine(model, engine.layer)).lookup({ namespace: "serial", value: "S002" }, nextDay, ctx))).toBeNull();
  expect(await run(service.lookup({ namespace: "serial", value: "S001" }, start, { ...ctx, tenant: "other" }))).toBeNull();
  await expect(run(service.assign({ ...assignment, value: "foreign" }, { ...ctx, tenant: "other" }))).rejects.toThrow();
  } finally { db.close(); }
});
