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
import { Clock, CursorSecret, IdGen, Storage } from "../../src/services.js";
import { productionIds } from "../../src/hosts/ids.js";
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
    );
    const engine = new Engine(model, layer);
    return createHttpHandler(model, engine, { auth: devHeaderAuth() })(request);
  },
};
