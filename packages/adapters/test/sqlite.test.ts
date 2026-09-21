/**
 * FORGE-073 / PAR-150: a SQLite-dialect engine is certified by demonstrated
 * guarantees, not by syntax compatibility. `node:sqlite` passes the
 * qualification suite and then the full conformance scenarios through the
 * D1 storage adapter; an engine that silently drops foreign keys is rejected.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Engine, ForgeError, Model, type AppBundle, type CallContext as EngineCtx } from "@forgegraph/runtime";
import { D1Storage } from "@forgegraph/runtime/d1";
import { Dispatcher } from "@forgegraph/runtime/dispatch";
import { MemoryObjectStore } from "@forgegraph/runtime/memory-objects";
import { internalSubscriptions, withProjections } from "@forgegraph/runtime/readmodels";
import { testLayer } from "@forgegraph/runtime/testing";
import { runScenario } from "../../../conformance/src/runner.js";
import { loadScenarios } from "../../../conformance/src/scenarios.js";
import type { CallContext, CallResult, Target } from "../../../conformance/src/target.js";
import { externals, functions } from "../../../examples/acme/impl/index.js";
import { createClient } from "@libsql/client";
import { PROFILES, libsqlExecutor, nodeSqliteExecutor, qualifySqlite } from "../src/sqlite.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const model = new Model(bundle);
// The tracked D1 migrations, in order: the same files `wrangler d1 migrations apply` runs.
const migrations = resolve(import.meta.dirname, "..", "..", "..", "examples", "acme", "migrations", "d1");
const ddl = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(resolve(migrations, f), "utf8")).join("\n");

describe("PAR-150: SQLite-dialect qualification", () => {
  it("embedded libsql (@libsql/client 0.18.0) demonstrates every D1 guarantee; the Turso cloud endpoint is qualified only when FORGE_TURSO_URL is set", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA foreign_keys = ON");
    const q = await qualifySqlite(PROFILES["libsql-embedded"]!, libsqlExecutor(client));
    expect(q.checks.filter((c) => !c.ok)).toEqual([]);
    expect(q).toMatchObject({ certified: true, engineVersion: expect.stringMatching(/^3\.\d+/) });
    if (process.env["FORGE_TURSO_URL"]) {
      const remote = createClient({ url: process.env["FORGE_TURSO_URL"], ...(process.env["FORGE_TURSO_TOKEN"] ? { authToken: process.env["FORGE_TURSO_TOKEN"] } : {}) });
      const qr = await qualifySqlite(PROFILES["turso"]!, libsqlExecutor(remote, { facade: "libsql-hrana" }));
      expect(qr.certified).toBe(true);
    }
  });

  it("node:sqlite demonstrates every D1 guarantee and is certified; the engine version is recorded", async () => {
    const q = await qualifySqlite(PROFILES["sqlite-node"]!, nodeSqliteExecutor(new DatabaseSync(":memory:")));
    expect(q.checks.filter((c) => !c.ok)).toEqual([]);
    expect(q.certified).toBe(true);
    expect(q.engineVersion).toMatch(/^3\.\d+/);
  });

  it("an engine with the same syntax but no foreign-key enforcement is rejected, whatever it is called", async () => {
    const q = await qualifySqlite({ ...PROFILES["turso"]!, id: "turso-like" }, nodeSqliteExecutor(new DatabaseSync(":memory:"), { facade: "libsql-like", foreignKeys: false }));
    expect(q.certified).toBe(false);
    expect(q.missing).toContain("foreign-keys");
    expect(q.missing).toContain("assertion-abort"); // the guarded batch relies on constraint enforcement too
    // partial batch application is rejected too
    const partial = nodeSqliteExecutor(new DatabaseSync(":memory:"));
    const broken = { ...partial, facade: "no-txn", batch: async (stmts: { sql: string; params: unknown[] }[]) => { const out = []; for (const s of stmts) out.push(await partial.run(s)); return out; } };
    const q2 = await qualifySqlite(PROFILES["sqlite-node"]!, broken);
    expect(q2.missing).toContain("atomic-batch");
  });
});

class SqliteTarget implements Target {
  readonly name: string;
  private engine!: Engine;
  private objects!: MemoryObjectStore;
  private dispatcher!: Dispatcher;
  private libsql: import("@libsql/client").Client | null = null;
  constructor(private readonly flavour: "sqlite-node" | "libsql-embedded" = "sqlite-node") { this.name = flavour; }
  private build() {
    this.objects = new MemoryObjectStore();
    let executor;
    if (this.flavour === "libsql-embedded") {
      // one embedded database file per target under the OS temp dir (":memory:" is shared per process in libsql)
      const file = join(tmpdir(), `forge-libsql-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
      this.libsql = createClient({ url: `file:${file}` });
      const c = this.libsql;
      this.pending = (async () => { await c.execute("PRAGMA foreign_keys = ON"); for (const stmt of ddl.split(";\n").map((x) => x.trim()).filter(Boolean)) await c.execute(stmt); })();
      executor = libsqlExecutor(this.libsql);
    } else {
      const db = new DatabaseSync(":memory:");
      db.exec(ddl);
      executor = nodeSqliteExecutor(db);
    }
    const storage = new D1Storage(executor, model);
    this.engine = new Engine(model, testLayer(storage, { objects: this.objects, runId: "sq" }), { functions, externals });
    this.dispatcher = new Dispatcher(model, storage, withProjections(this.engine, { name: "none", send: () => Effect.void }), { subscriptions: internalSubscriptions(this.engine), leaseMs: 1000, maxAttempts: 3 });
  }
  private pending: Promise<void> = Promise.resolve();
  async reset() { await this.pending; this.build(); await this.pending; }
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
    const c: EngineCtx = { tenant: ctx.tenant, actor: ctx.actor, requestId: "sq", ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}) };
    const exit = await Effect.runPromiseExit(this.engine.call(op, input, c));
    await Effect.runPromise(this.dispatcher.sweep(ctx.tenant, { now: Date.now() }));
    await Effect.runPromise(this.engine.workflows.sweep(ctx.tenant));
    if (exit._tag === "Success") return { ok: true, value: exit.value };
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return { ok: false, code: e.code, detail: e.problem("sq") };
    throw e;
  }
}

for (const flavour of ["sqlite-node", "libsql-embedded"] as const) {
  describe(`${flavour} profile: the full conformance suite through the D1 adapter`, () => {
    for (const scenario of loadScenarios()) {
      it(`scenario ${scenario.id}`, async () => {
        const report = await runScenario(scenario, new SqliteTarget(flavour), { tenant: `${flavour}-${scenario.id}` });
        expect(report.failures).toEqual([]);
      }, 60_000);
    }
  });
}
