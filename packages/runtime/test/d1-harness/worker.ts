/**
 * Test harness Worker: runs the engine over D1 through a facade chosen per
 * request (`x-facade: raw-d1 | drizzle | effect-sql`). Lets the facade suite
 * drive real D1 from Node without the workers vitest pool.
 */
import { Layer } from "effect";
import { D1Storage, type D1Like } from "../../src/adapters/d1.js";
import { drizzleD1Executor, effectSqlExecutor, rawD1Executor, type SqlExecutor } from "../../src/adapters/sql-executor.js";
import { Engine } from "../../src/engine.js";
import { createHttpHandler, devHeaderAuth } from "../../src/http.js";
import { Model, type AppBundle } from "../../src/model.js";
import { Clock, CursorSecret, IdGen, Objects, Storage } from "../../src/services.js";
import { MemoryObjectStore } from "../../src/adapters/memory-objects.js";
import { productionIds } from "../../src/hosts/ids.js";
import { Dispatcher, type Delivery } from "../../src/dispatch.js";
import { Effect } from "effect";
import bundle from "../../../../conformance/fixtures/acme.app.json";

const model = new Model(bundle as unknown as AppBundle);
const executors: Record<string, (db: D1Like) => SqlExecutor> = { "raw-d1": rawD1Executor, drizzle: drizzleD1Executor, "effect-sql": effectSqlExecutor };

export default {
  async fetch(request: Request, env: { DB: D1Like }): Promise<Response> {
    const facade = request.headers.get("x-facade") ?? "raw-d1";
    const mk = executors[facade];
    if (!mk) return new Response(`unknown facade ${facade}`, { status: 400 });
    const layer = Layer.mergeAll(
      Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
      Layer.succeed(IdGen)(productionIds()),
      Layer.succeed(Storage)(new D1Storage(mk(env.DB), model)),
      Layer.succeed(CursorSecret)({ key: "harness" }),
      Layer.succeed(Objects)(new MemoryObjectStore()),
    );
    const engine = new Engine(model, layer);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_forge/dispatch")) {
      const storage = new D1Storage(mk(env.DB), model);
      const tenant = request.headers.get("x-forge-tenant") ?? "acme";
      const body = request.method === "POST" ? ((await request.json()) as any) : {};
      const sent: string[] = [];
      const failFor = new Set<string>(body.failFor ?? []);
      const transport = { name: "harness", send: (d: Delivery) => (failFor.has(d.subscription) ? Effect.fail(new Error("down")) : Effect.sync(() => void sent.push(d.subscription))) };
      const dispatcher = new Dispatcher(model, storage, transport, { subscriptions: { "@acme/commerce/_/Customer.changes": ["a", "b"] }, leaseMs: 5000, maxAttempts: 2, owner: "harness" });
      if (url.pathname === "/_forge/dispatch") return Response.json({ report: await Effect.runPromise(dispatcher.sweep(tenant, { now: Number(body.now) })), sent });
      if (url.pathname === "/_forge/dispatch/dead") return Response.json(await Effect.runPromise(dispatcher.dead(tenant)));
      if (url.pathname === "/_forge/dispatch/redrive") return Response.json({ ok: await Effect.runPromise(dispatcher.redrive(tenant, body.opId, Number(body.ordinal))) });
      if (url.pathname === "/_forge/dispatch/consume") return Response.json({ outcome: await dispatcher.consumer(body.subscription, async () => {})({ channel: "c", message: "M", tenant, opId: "x", ordinal: 0, messageId: body.messageId, payload: {}, createdAt: "t" }) });
    }
    return createHttpHandler(model, engine, { auth: devHeaderAuth() })(request);
  },
};
