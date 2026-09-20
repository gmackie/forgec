/** Cloudflare Workers host: builds the runtime Layer from bindings per invocation. */
import { Layer } from "effect";
import { D1Storage, type D1Like } from "../adapters/d1.js";
import { R2ObjectStore, type R2Like } from "../adapters/r2.js";
import { Engine } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import { Clock, CursorSecret, IdGen, Objects, Storage } from "../services.js";
import { productionIds } from "./ids.js";
import { MemoryObjectStore } from "../adapters/memory-objects.js";

export interface WorkerEnv {
  DB: D1Like;
  BLOBS?: R2Like;
  CURSOR_SECRET: string;
  FORGE_AUTH?: string;
}

export function createWorker(bundle: AppBundle, options: { auth?: AuthHost } = {}) {
  const model = new Model(bundle);
  return {
    async fetch(request: Request, env: WorkerEnv): Promise<Response> {
      const auth = options.auth ?? (env.FORGE_AUTH === "dev-headers" ? devHeaderAuth() : null);
      if (!auth) return new Response(JSON.stringify({ code: "Unauthenticated", detail: "no authentication host configured (set FORGE_AUTH=dev-headers for development)" }), { status: 401, headers: { "content-type": "application/problem+json" } });
      const url = new URL(request.url);
      const objects = env.BLOBS ? new R2ObjectStore(env.BLOBS, { baseUrl: `${url.protocol}//${url.host}`, secret: env.CURSOR_SECRET }) : null;
      // Object bytes: the Worker-served equivalent of presigned URLs (bearer token, one key, one method).
      const m = /^\/_forge\/objects\/([^/]+)$/.exec(url.pathname);
      if (m && objects) return objects.serve(request, m[1]!);
      const layer = Layer.mergeAll(
        Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
        Layer.succeed(IdGen)(productionIds()),
        Layer.succeed(Storage)(new D1Storage(env.DB, model)),
        Layer.succeed(CursorSecret)({ key: env.CURSOR_SECRET }),
        Layer.succeed(Objects)(objects ?? new MemoryObjectStore()),
      );
      const engine = new Engine(model, layer);
      const handler = createHttpHandler(model, engine, { auth, requestId: (req) => req.headers.get("cf-ray") ?? crypto.randomUUID() });
      return handler(request);
    },
  };
}
