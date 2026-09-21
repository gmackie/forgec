/**
 * Engine-backed conformance targets for every locally certifiable storage
 * profile: the in-memory reference, `sqlite-node` through the D1 adapter, and
 * PostgreSQL. One class, one construction path, so a differential run compares
 * adapters and nothing else.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cause, Effect } from "effect";
import type pg from "pg";
import { Dispatcher, Engine, ForgeError, internalSubscriptions, MemoryObjectStore, MemoryStorage, Model, testLayer, withProjections, type AppBundle, type CallContext as EngineCtx, type StorageAdapter } from "@forgegraph/runtime";
import { D1Storage } from "@forgegraph/runtime/d1";
import { createPostgresStorage } from "@forgegraph/runtime/postgres";
import { nodeSqliteExecutor } from "@forgegraph/adapters/sqlite";
import { externals, functions } from "../../examples/acme/impl/index.js";
import type { CallContext, CallResult, Target } from "./target.js";

export type ProfileName = "runtime-memory" | "sqlite-node" | "node-postgres";

export interface ProfileOptions { bundle: AppBundle; profile: ProfileName; pool?: pg.Pool; /** A migrations directory (applied in order) or a single DDL file for sqlite-node. */ migrationsDir?: string; ddlFile?: string; idPrefix?: string }

export class ProfileTarget implements Target {
  readonly name: string;
  engine!: Engine;
  private objects!: MemoryObjectStore;
  private dispatcher!: Dispatcher;
  private readonly model: Model;
  constructor(private readonly o: ProfileOptions) {
    this.name = o.profile;
    this.model = new Model(o.bundle);
    this.build();
  }
  private storage(): StorageAdapter {
    switch (this.o.profile) {
      case "runtime-memory":
        return new MemoryStorage();
      case "sqlite-node": {
        const db = new DatabaseSync(":memory:");
        if (this.o.ddlFile) db.exec(readFileSync(this.o.ddlFile, "utf8"));
        else {
          const dir = this.o.migrationsDir ?? resolve(import.meta.dirname, "..", "..", "examples", "acme", "migrations", "d1");
          db.exec(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n"));
        }
        return new D1Storage(nodeSqliteExecutor(db), this.model);
      }
      case "node-postgres":
        if (!this.o.pool) throw new Error("node-postgres profile needs a pg pool");
        return createPostgresStorage(this.o.pool, this.model);
    }
  }
  private build(): void {
    this.objects = new MemoryObjectStore();
    const storage = this.storage();
    this.engine = new Engine(this.model, testLayer(storage, { objects: this.objects, runId: "diff", ...(this.o.idPrefix ? { idPrefix: this.o.idPrefix } : {}) }), { functions, externals });
    this.dispatcher = new Dispatcher(this.model, storage, withProjections(this.engine, { name: "none", send: () => Effect.void }), { subscriptions: internalSubscriptions(this.engine), leaseMs: 1000, maxAttempts: 3 });
  }
  async reset(): Promise<void> {
    this.build();
  }
  async transfer(signed: { url: string; method: string; headers?: Record<string, string> }, body?: Uint8Array): Promise<{ status: number; bytes: Uint8Array }> {
    if (signed.method === "PUT") {
      const declared = Number(signed.headers?.["content-length"] ?? NaN);
      const bytes = body ?? new Uint8Array();
      if (Number.isFinite(declared) && declared !== bytes.length) return { status: 413, bytes: new Uint8Array() };
      await this.objects.simulateUpload(signed.url, bytes, signed.headers?.["content-type"] ?? "application/octet-stream");
      return { status: 204, bytes: new Uint8Array() };
    }
    return { status: 200, bytes: await this.objects.simulateDownload(signed.url) };
  }
  async call(op: string, input: unknown, ctx: CallContext & { purpose?: string; maintenance?: boolean }): Promise<CallResult> {
    const c: EngineCtx = { tenant: ctx.tenant, actor: ctx.actor, requestId: this.name, ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}), ...(ctx.purpose ? { purpose: ctx.purpose } : {}), ...(ctx.maintenance ? { maintenance: true } : {}) };
    const exit = await Effect.runPromiseExit(this.engine.call(op, input, c));
    await Effect.runPromise(this.dispatcher.sweep(ctx.tenant, { now: Date.now() }));
    await Effect.runPromise(this.engine.workflows.sweep(ctx.tenant));
    if (exit._tag === "Success") return { ok: true, value: exit.value };
    const e = Cause.squash(exit.cause);
    if (e instanceof ForgeError) return { ok: false, code: e.code, detail: e.problem(this.name) };
    throw e;
  }
}
