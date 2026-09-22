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
import { localAuthorizer } from "../src/gatekeeper.js";
import { Participations } from "../src/foundation/participation.js";
const fixture = process.env["FORGE_FOUNDATION_FIXTURE"] ?? resolve(import.meta.dirname, "../../../conformance/fixtures/participation");
const bundle = JSON.parse(readFileSync(resolve(fixture, "app.json"), "utf8")) as AppBundle;
const prefix = "@forgegraph/foundation/participation/_/";
const ctx = { tenant: "acme", actor: "user", requestId: "participation" };
for (const adapter of ["memory", "sqlite"]) it(`${adapter}: typed participation, vocabulary and temporal history`, async () => {
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
  const service = new Participations(engine, { namespace: "review-board", roles: ["reviewer", "chair"] as const });
  const run = Effect.runPromise;
  const set = await call("ParticipationSet.create", { label: "Board" });
  const participant = await call("Participant.create", { label: "Member" });
  await run(service.registerRole("reviewer", ctx));
  await run(service.registerRole("chair", ctx));
  const start = "2026-01-01T00:00:00Z", end = "2026-02-01T00:00:00Z";
  const input = { participationSet: String(set.id), participant: String(participant.id), role: "reviewer" as const, validFrom: start, reason: "Appointed" };
  const memberships = await Promise.allSettled(Array.from({ length: 8 }, () => run(service.add(input, ctx))));
  expect(memberships.filter(x => x.status === "fulfilled")).toHaveLength(1);
  const membership = (memberships.find(x => x.status === "fulfilled") as PromiseFulfilledResult<Record<string, unknown>>).value;
  expect(membership.recordedBy).toBe(ctx.actor);
  expect((await run(service.listAt(String(set.id), start, ctx))).items).toEqual([{ participation: membership.id, participant: participant.id, role: "reviewer", participationSet: set.id }]);
  expect((await run(service.listAt(String(set.id), "2025-12-31T23:59:59Z", ctx))).items).toHaveLength(0);
  const ends = await Promise.allSettled([
    run(service.end(String(membership.id), end, "Term ended", ctx)),
    run(service.revoke(String(membership.id), end, "Revoked", ctx)),
  ]);
  expect(ends.filter(x => x.status === "fulfilled")).toHaveLength(1);
  expect((await run(service.listAt(String(set.id), end, ctx))).items).toHaveLength(0);
  expect((await run(service.listAt(String(set.id), start, ctx))).items).toHaveLength(1);
  const chair = await run(service.add({ ...input, role: "chair", validUntil: end }, ctx));
  expect((await run(service.listAt(String(set.id), end, ctx))).items).toHaveLength(0);
  await expect(run(service.end(String(chair.id), "2025-12-01T00:00:00Z", "Invalid", ctx))).rejects.toThrow();
  await expect(run(service.add({ ...input, role: "unknown" as "reviewer" }, ctx))).rejects.toThrow();
  await expect(run(service.add({ ...input, validUntil: start }, ctx))).rejects.toThrow();
  const guarded = new Engine(model, engine.layer);
  guarded.gatekeeper.authorizer = localAuthorizer({
    policies: ["Participation", "ParticipationRole"].map(name => ({ id: name, actions: [prefix + name + ".*"], requires: [], where: [] })),
    pips: [], epoch: 1, knownObligations: [],
  });
  const guardedFacts = new Participations(guarded, { namespace: "review-board", roles: ["reviewer"] });
  await expect(run(guardedFacts.listAt(String(set.id), start, ctx))).rejects.toMatchObject({ code: "NotFound" });
  const classroom = new Participations(engine, { namespace: "classroom", roles: ["reviewer"] });
  expect((await run(classroom.listAt(String(set.id), start, ctx))).items).toHaveLength(0);
  for (const resource of ["Participation", "ParticipationEnd", "Participant"]) await expect(call(resource + ".delete", { id: membership.id })).rejects.toThrow();
  expect((await run(service.listAt(String(set.id), start, { ...ctx, tenant: "other" }))).items).toHaveLength(0);
  await expect(run(service.add(input, { ...ctx, tenant: "other" }))).rejects.toThrow();
  } finally { db.close(); }
});
