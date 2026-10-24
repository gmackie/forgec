/**
 * FORG-37: the runtime split by feature. `EngineCore` links only the features it is given, so a host
 * bundling it with a slice's features carries none of the others' code; `Engine` and `createWorker`
 * link every feature and behave as before. A model that uses a feature the engine does not link is
 * refused when the engine (or Worker) is built, never on a request.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/adapters/memory.js";
import { libsqlExecutor } from "../src/adapters/libsql-executor.js";
import type { D1Like } from "../src/adapters/d1.js";
import { Engine, EngineCore } from "../src/engine.js";
import { allFeatures, checkFeatures, featuresNamed, requiredFeatures, workflows } from "../src/features.js";
import { cloudflareObjects, createWorker, createWorkerWith } from "../src/hosts/cloudflare.js";
import { devHeaderAuth } from "../src/http.js";
import { Model, type AppBundle } from "../src/model.js";
import { testLayer } from "../src/testing.js";

const bundle = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "..", "conformance", "fixtures", "acme.app.json"), "utf8")) as AppBundle;
const migration = readFileSync(resolve(import.meta.dirname, "d1-harness", "migrations", "0001_all.sql"), "utf8");
const ALL = ["blobs", "changesets", "dispatch", "governance", "imports", "portability", "readModels", "realtime", "schedules", "workflows"];

/** Acme without the declarations that need optional features: what a CRUD slice looks like to the runtime. */
function crudOnly(): AppBundle {
  const b = structuredClone(bundle);
  for (const m of b.ir.modules) {
    m.workflows = [];
    m.sources = [];
    m.views = [];
    m.projections = [];
    m.caches = [];
    m.channels = (m.channels ?? []).map(({ websocket: _, ...c }) => c);
    m.resources = m.resources.filter((r) => r.kind !== "blob");
  }
  return b;
}
const ctx = { tenant: "t1", actor: "a", requestId: "r" };

describe("runtime features (FORG-37)", () => {
  it("Engine links every feature, as it always has", () => {
    const engine = new Engine(new Model(bundle), testLayer(new MemoryStorage()));
    expect(engine.features.sort()).toEqual(ALL);
    expect(allFeatures.map((f) => f.name).sort()).toEqual(ALL);
    expect(engine.workflows).toBe(engine.feature("workflows"));
  });

  it("derives what a model needs, and EngineCore refuses a model whose features are not linked", () => {
    const model = new Model(bundle);
    expect(requiredFeatures(model)).toEqual(["blobs", "governance", "readModels", "realtime", "schedules", "workflows"]);
    expect(requiredFeatures(new Model(crudOnly()))).toEqual([]);
    expect(() => new EngineCore(model, testLayer(new MemoryStorage()), { features: [workflows] })).toThrow(/needs the blobs, governance, readModels, realtime, schedules features/);
    // A linked feature brings what it calls into: imports stages through changesets.
    expect(() => checkFeatures(new Model(crudOnly()), featuresNamed(["imports"]))).toThrow(/needs the changesets feature/);
    expect(() => featuresNamed(["telepathy"])).toThrow(/unknown runtime feature telepathy/);
  });

  it("EngineCore without features serves CRUD, refuses unlinked surfaces, and still honours a write fence", async () => {
    const storage = new MemoryStorage();
    const engine = new EngineCore(new Model(crudOnly()), testLayer(storage));
    expect(engine.features).toEqual([]);
    expect(engine.feature("changesets")).toBeUndefined();
    expect(() => engine.workflows).toThrow(/workflows feature is not linked/);

    const created = await Effect.runPromise(engine.call("@acme/commerce/_/Customer.create", { code: "C-1", name: "One" }, ctx));
    expect(created["code"]).toBe("C-1");
    const refused = await Effect.runPromise(Effect.flip(engine.call("@acme/commerce/_/changesets.propose", { operations: [] }, ctx)));
    expect(refused.code).toBe("MethodNotAllowed");
    expect(refused.detail).toMatch(/changesets feature is not linked/);

    // The fence lives in portability's storage, but every writer checks it without the admin feature.
    await Effect.runPromise(storage.putDocument("t1", "admin", "fence", { on: true }, null));
    const fenced = await Effect.runPromise(Effect.flip(engine.call("@acme/commerce/_/Customer.create", { code: "C-2", name: "Two" }, ctx)));
    expect(fenced.code).toBe("WriteFenced");
  });

  it("createWorkerWith refuses a Worker that could not deliver its outbox or store blobs", () => {
    const crud = crudOnly();
    expect(() => createWorkerWith(crud, { features: [] })).toThrow(/without the dispatch feature needs postCommit/);
    expect(() => createWorkerWith(crud, { features: [], postCommit: async () => undefined })).toThrow(/sweeps.outbox: false/);
    expect(() => createWorkerWith(crud, { features: [], postCommit: async () => undefined, sweeps: { outbox: false } })).not.toThrow();
    expect(() => createWorkerWith(bundle, { features: featuresNamed([...requiredFeatures(new Model(bundle)), "dispatch"]) })).toThrow(/blobs feature needs objects/);
    expect(() => createWorkerWith(bundle, { features: featuresNamed(["dispatch"]) })).toThrow(/needs the blobs, governance/);
    expect(() => createWorkerWith(bundle, { features: featuresNamed([...requiredFeatures(new Model(bundle)), "dispatch"]), objects: cloudflareObjects })).not.toThrow();
  });

  it("a feature-linked Worker answers like the whole-app Worker for what it serves, and refuses what it does not link", async () => {
    const client = createClient({ url: "file::memory:" });
    await client.executeMultiple(migration);
    const env = { DB: libsqlExecutor(client) as unknown as D1Like, CURSOR_SECRET: "test" };
    const handedOff: string[] = [];
    const sliced = createWorkerWith(crudOnly(), { features: [], auth: devHeaderAuth(), postCommit: async (_e, tenant) => void handedOff.push(tenant), sweeps: { outbox: false } });
    const whole = createWorker(bundle, { auth: devHeaderAuth() });
    const headers = { "content-type": "application/json", "x-forge-tenant": "t1", "x-forge-actor": "a" };
    const post = (worker: { fetch: (r: Request, e: never, c: { waitUntil(p: Promise<unknown>): void }) => Promise<Response> }, path: string, body: unknown) => {
      const pending: Promise<unknown>[] = [];
      return worker.fetch(new Request(`https://forge.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env as never, { waitUntil: (p) => void pending.push(p) }).then(async (r) => (await Promise.all(pending), r));
    };
    const a = await post(sliced, "/v1/customers", { code: "C-1", name: "One" });
    expect(a.status).toBe(201);
    expect(handedOff).toEqual(["t1"]);
    const b = await post(whole, "/v1/customers", { code: "C-1", name: "One" });
    expect([b.status, ((await b.json()) as { code: string }).code]).toEqual([409, "UniqueConflict"]);
    const cs = await post(sliced, "/v1/changesets", { mode: "atomic", operations: [] });
    expect(cs.status).toBe(405);
  });
});
