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
  constructor(private readonly executor: SqlExecutor, private readonly runId: string) {
    this.name = `postgres/${executor.facade}`;
    this.build();
  }
  private build() {
    this.objects = new MemoryObjectStore();
    const storage = new PostgresStorage(this.executor, model);
    this.engine = new Engine(model, testLayer(storage, { objects: this.objects, runId: this.runId }), { functions, externals });
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
