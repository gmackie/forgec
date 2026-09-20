/** Cloudflare Workers host: builds the runtime Layer from bindings per invocation. */
import { Layer } from "effect";
import { D1Storage, type D1Like } from "../adapters/d1.js";
import { Engine } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import { Clock, CursorSecret, IdGen, Storage } from "../services.js";
import { productionIds } from "./ids.js";

export interface WorkerEnv {
  DB: D1Like;
  CURSOR_SECRET: string;
  FORGE_AUTH?: string;
}

export function createWorker(bundle: AppBundle, options: { auth?: AuthHost } = {}) {
  const model = new Model(bundle);
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const auth = options.auth ?? (env.FORGE_AUTH === "dev-headers" ? devHeaderAuth() : null);
      if (!auth) return new Response(JSON.stringify({ code: "Unauthenticated", detail: "no authentication host configured (set FORGE_AUTH=dev-headers for development)" }), { status: 401, headers: { "content-type": "application/problem+json" } });
      const layer = Layer.mergeAll(
        Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
        Layer.succeed(IdGen)(productionIds()),
        Layer.succeed(Storage)(new D1Storage(env.DB, model)),
        Layer.succeed(CursorSecret)({ key: env.CURSOR_SECRET }),
      );
      const engine = new Engine(model, layer);
      const handler = createHttpHandler(model, engine, { auth, requestId: (req) => req.headers.get("cf-ray") ?? crypto.randomUUID() });
      return handler(request);
    },
  };
}
