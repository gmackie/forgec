/**
 * FORGE-033/034/036: PostgreSQL runs the whole conformance suite with the
 * same invariants as D1 and DynamoDB, through both facades, with pooled
 * connections that never retain tenant context. Requires FORGE_PG_URL
 * (e.g. postgres://forge@localhost:55433/forge_test); the schema is
 * recreated from the generated PostgreSQL baseline on every run.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenario } from "../../../conformance/src/runner.js";
import { loadScenarios } from "../../../conformance/src/scenarios.js";
import type { CallContext, CallResult, Target } from "../../../conformance/src/target.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { Dispatcher } from "../src/dispatch.js";
import { Engine, type CallContext as EngineCtx } from "../src/engine.js";
import { ForgeError } from "../src/errors.js";
import { Model, type AppBundle } from "../src/model.js";
import { MemoryObjectStore } from "../src/adapters/memory-objects.js";
import { MemoryStorage } from "../src/adapters/memory.js";
import { drizzlePgExecutor, PostgresStorage, rawPgExecutor } from "../src/adapters/postgres.js";
import { internalSubscriptions, withProjections } from "../src/readmodels.js";
import { testLayer } from "../src/testing.js";
import type { SqlExecutor } from "../src/adapters/sql-executor.js";

const url = process.env["FORGE_PG_URL"];
const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
const schema = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "examples", "acme", "generated", "postgres", "0001_init.sql"), "utf8");

class PgTarget implements Target {
  readonly name: string;
  private engine!: Engine;
  private objects!: MemoryObjectStore;
  private dispatcher!: Dispatcher;
  constructor(private readonly executor: SqlExecutor, private readonly runId: string, private readonly idPrefix = "") {
    this.name = `postgres/${executor.facade}`;
    this.build();
  }
  private build() {
    this.objects = new MemoryObjectStore();
    const storage = new PostgresStorage(this.executor, model);
    this.engine = new Engine(model, testLayer(storage, { objects: this.objects, runId: this.runId, idPrefix: this.idPrefix }), { functions, externals });
    this.dispatcher = new Dispatcher(model, storage, withProjections(this.engine, { name: "none", send: () => Effect.void }), { subscriptions: internalSubscriptions(this.engine), leaseMs: 1000, maxAttempts: 3 });
  }
  async reset() { this.build(); }
  async transfer(signed: { url: string; method: string; headers?: Record<string, string> }, body?: Uint8Array) {
    if (signed.method === "PUT") {
      const declared = Number(signed.headers?.["content-length"] ?? NaN);
      const bytes = body ?? new Uint8Array();
      if (Number.isFinite(declared) && declared !== bytes.length) return { status: 413, bytes: new Uint8Array() };
      await this.objects.simulateUpload(signed.url, bytes, signed.headers?.["content-type"] ?? "application/octet-stream");
      return { status: 204, bytes: new Uint8Array() };
    }
    return { status: 200, bytes: await this.objects.simulateDownload(signed.url) };
  }
  async call(op: string, input: unknown, ctx: CallContext): Promise<CallResult> {
    const c: EngineCtx = { tenant: ctx.tenant, actor: ctx.actor, requestId: "pg", ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}) };
    const exit = await Effect.runPromiseExit(this.engine.call(op, input, c));
    await Effect.runPromise(this.dispatcher.sweep(ctx.tenant, { now: Date.now() }));
    await Effect.runPromise(this.engine.workflows.sweep(ctx.tenant));
    if (exit._tag === "Success") return { ok: true, value: exit.value };
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return { ok: false, code: e.code, detail: e.problem("pg") };
    throw e;
  }
}

describe.skipIf(!url)("PostgreSQL adapter", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(schema);
  });
  afterAll(async () => { await pool?.end(); });

  // Under SERIALIZABLE every commit touches `_forge_assert` and `forge_outbox`, so concurrent
  // commits are pivot candidates even when they share no business state. 40001 is the documented,
  // expected outcome there and the documented remedy is to retry — so writes that do not conflict
  // logically must still all succeed. D1 sees this rarely (one writer); PostgreSQL sees it under
  // any real concurrency, which is exactly the portability gap this asserts against.
  it("concurrent commits that share no business state all succeed despite serialization conflicts", async () => {
    const A = "@acme/commerce/_";
    // Its own pool: the shared one caps at 4 connections, which serializes the calls and hides
    // the conflict this is about.
    const hot = new pg.Pool({ connectionString: url, max: 16 });
    try {
      const target = new PgTarget(rawPgExecutor(hot), `pg-contention-${Date.now().toString(36)}`);
      const tenant = `pg-contention-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const N = 64;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          target.call(`${A}/Customer.create`, { code: `C${String(i).padStart(3, "0")}`, name: `Customer ${i}` }, { tenant, actor: "operator" }),
        ),
      );
      const failed = results.filter((r) => !r.ok);
      expect(failed, `${failed.length}/${N} concurrent creates failed: ${JSON.stringify(failed.slice(0, 3))}`).toEqual([]);
      // and every one of them is actually durable, not merely reported as written
      const ids = results.map((r) => (r.ok ? (r.value as { id: string }).id : ""));
      const fetched = await Promise.all(ids.map((id) => target.call(`${A}/Customer.get`, { id }, { tenant, actor: "operator" })));
      expect(fetched.filter((r) => !r.ok)).toEqual([]);
    } finally {
      // a failed assertion must not leave 16 connections open: vitest would hang on teardown
      await hot.end();
    }
  }, 120_000);

  it("pooled connections never retain transaction-local tenant context (PAR-087)", async () => {
    const one = new pg.Pool({ connectionString: url, max: 1 });
    const ex = rawPgExecutor(one);
    await ex.batch([{ sql: "INSERT INTO forge_document (tenant, kind, id, version, body) VALUES (?, ?, ?, 1, '{}')", params: ["t-ctx", "k", "a"] }]);
    const after = await one.query("SELECT current_setting('forge.tenant', true) AS t");
    expect(after.rows[0].t ?? "").toBe("");
    await one.end();
  });

  it("classifies unique, reference and precondition failures like D1 (PAR-085)", async () => {
    const t = new PgTarget(rawPgExecutor(pool), "cls");
    const ctx = { tenant: `pg-cls-${Date.now().toString(36)}`, actor: "a" };
    const c = await t.call("@acme/commerce/_/Customer.create", { code: "DUP", name: "A" }, ctx);
    expect(c.ok).toBe(true);
    expect(await t.call("@acme/commerce/_/Customer.create", { code: "DUP", name: "B" }, ctx)).toMatchObject({ ok: false, code: "UniqueConflict" });
    expect(await t.call("@acme/commerce/_/Site.create", { customer: "cus_nope", code: "hq", name: "HQ", timezone: "UTC" }, ctx)).toMatchObject({ ok: false, code: "ReferenceMissing" });
    const id = (c as { value: { id: string } }).value.id;
    expect(await t.call("@acme/commerce/_/Customer.update", { id, expectedVersion: 9, patch: { name: "X" } }, ctx)).toMatchObject({ ok: false, code: "VersionConflict" });
  });

  /** PAR-146: cross-database cutover. A memory (D1-shaped) source with records, a sealed blob and a live
   *  workflow instance is exported under a write fence and imported into PostgreSQL; verification agrees on
   *  ids, revisions and canonical hashes, and no workflow history appears on the target. */
  it("PAR-146: export under fence -> import into PostgreSQL -> verify; workflow history is drained, not fabricated", async () => {
    const tenant = `pg-cutover-${Date.now().toString(36)}`;
    const ctx: EngineCtx = { tenant, actor: "operator", requestId: "cut" };
    const A = "@acme/commerce/_";
    const sourceObjects = new MemoryObjectStore();
    const source = new Engine(model, testLayer(new MemoryStorage(), { objects: sourceObjects, runId: "src" }), { functions, externals });
    const call = (e: Engine, op: string, input: unknown) => Effect.runPromise(e.call(op, input, ctx) as Effect.Effect<Record<string, unknown>, never, never>);
    const c = await call(source, `${A}/Customer.create`, { code: "CUT", name: "Cutover" });
    const s = await call(source, `${A}/Site.create`, { customer: c["id"], code: "hq", name: "HQ", timezone: "UTC" });
    const o = await call(source, `${A}/Order.create`, { customer: c["id"], site: s["id"], subtotal: "10.00", tax: "1.00", requestedOn: "2026-09-20" });
    await call(source, `${A}/Order.update`, { id: o["id"], expectedVersion: 1, patch: { notes: "revised" } });
    // a sealed blob: its manifest (digest, bytes) travels with the record; bytes are copied by digest
    const doc = await call(source, `${A}/OrderDocument.create`, { order: o["id"], kind: "invoice", label: "invoice.pdf" });
    const up = await call(source, `${A}/OrderDocument.beginUpload`, { id: doc["id"], expectedVersion: 1, mediaType: "application/pdf", byteCount: 5 });
    await sourceObjects.simulateUpload((up["upload"] as { url: string }).url, new TextEncoder().encode("hello"), "application/pdf");
    await call(source, `${A}/OrderDocument.finalizeUpload`, { id: doc["id"], expectedVersion: 2 });
    // a live workflow instance (waits for payment): provider-native state
    const wf = await call(source, `${A}/ProcessOrder.start`, { order: o["id"], expectedVersion: 2 });
    expect(["running", "waiting", "sleeping"]).toContain(wf["status"]);
    // fence, export
    await call(source, `${A}/admin.fence`, { enabled: true });
    const snap = await call(source, `${A}/admin.export`, {});
    expect(snap["excluded"]).toMatchObject({ workflowInstances: 1 });
    expect((snap["manifest"] as { resources: string[] }).resources).not.toContain("_forge/workflow");
    // import into PostgreSQL under its own fence, then verify on both sides
    const target = new PgTarget(rawPgExecutor(pool), "cut", "t"); // a fresh id space, as a real deployment's ULIDs would be
    const tcall = async (op: string, input: unknown) => { const r = await target.call(op, input, { tenant, actor: "operator" }); if (!r.ok) throw new Error(`${op}: ${r.code}`); return r.value as Record<string, unknown>; };
    await tcall(`${A}/admin.fence`, { enabled: true });
    const imported = await tcall(`${A}/admin.import`, { snapshot: snap });
    expect(Object.keys(imported["imported"] as object).length).toBeGreaterThan(3);
    const verifyTarget = await tcall(`${A}/admin.verify`, { snapshot: snap });
    expect(verifyTarget["ok"]).toBe(true);
    const verifySource = await call(source, `${A}/admin.verify`, { snapshot: snap });
    expect(verifySource["ok"]).toBe(true);
    // identities and revisions match record by record
    await tcall(`${A}/admin.fence`, { enabled: false });
    await call(source, `${A}/admin.fence`, { enabled: false });
    const onSource = await call(source, `${A}/Order.get`, { id: o["id"] });
    const got = await tcall(`${A}/Order.get`, { id: o["id"] });
    expect(got).toEqual(onSource); // the workflow had already submitted it on the source: that revision is what moved
    expect(got).toMatchObject({ id: o["id"], version: 3, status: "Submitted", notes: "revised", total: "11.00" });
    const gotDoc = await tcall(`${A}/OrderDocument.get`, { id: doc["id"] });
    expect(gotDoc).toEqual(await call(source, `${A}/OrderDocument.get`, { id: doc["id"] }));
    expect(gotDoc["version"]).toBe(3); // create, beginUpload, finalize: the sealed manifest moved with its revision
    // no workflow history was fabricated on the target
    const missing = await target.call(`${A}/ProcessOrder.get`, { id: wf["id"] }, { tenant, actor: "operator" });
    expect(missing).toMatchObject({ ok: false, code: "NotFound" });
    // a uniqueness invariant holds natively on the target after import (claims were rebuilt, not copied)
    expect(await target.call(`${A}/Customer.create`, { code: "CUT", name: "Again" }, { tenant, actor: "operator" })).toMatchObject({ ok: false, code: "UniqueConflict" });
  });

  for (const facade of ["raw-pg", "drizzle-pg"] as const) {
    for (const scenario of loadScenarios()) {
      it(`${facade}: ${scenario.id}`, async () => {
        const executor = facade === "raw-pg" ? rawPgExecutor(pool) : await drizzlePgExecutor(pool);
        const report = await runScenario(scenario, new PgTarget(executor, `${facade}-${scenario.id}`), { tenant: `pg-${facade}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` });
        expect(report.failures).toEqual([]);
      }, 120_000);
    }
  }
});
