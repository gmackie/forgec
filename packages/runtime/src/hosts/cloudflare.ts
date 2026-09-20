/** Cloudflare Workers host: builds the runtime Layer from bindings per invocation. */
import { Effect, Layer } from "effect";
import { D1Storage, type D1Like } from "../adapters/d1.js";
import { R2ObjectStore, type R2Like } from "../adapters/r2.js";
import { Engine } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import { Dispatcher } from "../dispatch.js";
import { withProjections } from "../readmodels.js";
import { cloudflareQueuesTransport, decodeEnvelope, type QueueLike } from "../transports.js";
import type { EngineOptions } from "../engine.js";
import { Clock, CursorSecret, IdGen, Objects, Storage } from "../services.js";
import { productionIds } from "./ids.js";
import { MemoryObjectStore } from "../adapters/memory-objects.js";

export interface WorkerEnv {
  DB: D1Like;
  BLOBS?: R2Like;
  CURSOR_SECRET: string;
  FORGE_AUTH?: string;
  FORGE_CORS?: string;
  /** Queue producer bindings, one per logical subscription, named `Q_<SUBSCRIPTION>` (kebab -> upper snake). */
  [binding: string]: unknown;
}

function queueBindings(model: Model, env: WorkerEnv): Record<string, QueueLike> {
  const out: Record<string, QueueLike> = {};
  for (const s of model.bundle.messaging?.subscriptions ?? []) {
    const q = env[`Q_${s.name.toUpperCase().replace(/-/g, "_")}`] as QueueLike | undefined;
    if (q) out[s.name] = q;
  }
  return out;
}

export interface WorkerOptions extends EngineOptions {
  auth?: AuthHost;
}

export function createWorker(bundle: AppBundle, options: WorkerOptions = {}) {
  const model = new Model(bundle);
  const subscriptions: Record<string, string[]> = {};
  for (const s of model.bundle.messaging?.subscriptions ?? []) (subscriptions[s.channel] ??= []).push(s.name);

  const build = (env: WorkerEnv, baseUrl: string) => {
    const objects = env.BLOBS ? new R2ObjectStore(env.BLOBS, { baseUrl, secret: env.CURSOR_SECRET }) : null;
    const storage = new D1Storage(env.DB, model);
    const layer = Layer.mergeAll(
      Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
      Layer.succeed(IdGen)(productionIds()),
      Layer.succeed(Storage)(storage),
      Layer.succeed(CursorSecret)({ key: env.CURSOR_SECRET }),
      Layer.succeed(Objects)(objects ?? new MemoryObjectStore()),
    );
    const engine = new Engine(model, layer, options);
    const dispatcher = new Dispatcher(model, storage, withProjections(engine, cloudflareQueuesTransport(queueBindings(model, env))), { subscriptions: engine.projectionSubscriptions(subscriptions), leaseMs: 30_000, maxAttempts: 8 });
    return { engine, storage, objects, dispatcher };
  };

  return {
    /** Cron trigger: the durable outbox sweep (plan §14: waitUntil nudges are not a delivery guarantee). */
    async scheduled(_event: unknown, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
      const { storage, dispatcher } = build(env, "https://scheduled.invalid");
      const tenants = await Effect.runPromise(storage.outboxTenants());
      ctx.waitUntil(Promise.all(tenants.map((t: string) => Effect.runPromise(dispatcher.sweep(t, { now: Date.now() })))));
    },
    /** Queue consumer: every message is a forge envelope for exactly one subscription (the queue's). */
    async queue(batch: { queue: string; messages: { body: unknown; ack(): void; retry(): void }[] }, env: WorkerEnv): Promise<void> {
      const { engine } = build(env, "https://queue.invalid");
      const sub = (model.bundle.messaging?.subscriptions ?? []).find((s) => s.queue === batch.queue);
      for (const m of batch.messages) {
        if (!sub) {
          m.ack();
          continue;
        }
        try {
          await engine.consume(sub.name, decodeEnvelope(m.body));
          m.ack();
        } catch (e) {
          console.error("forge: consumer failed", sub.name, e);
          m.retry();
        }
      }
    },
    async fetch(request: Request, env: WorkerEnv, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
      const auth = options.auth ?? (env.FORGE_AUTH === "dev-headers" ? devHeaderAuth() : null);
      if (!auth) return new Response(JSON.stringify({ code: "Unauthenticated", detail: "no authentication host configured (set FORGE_AUTH=dev-headers for development)" }), { status: 401, headers: { "content-type": "application/problem+json" } });
      const url = new URL(request.url);
      const { engine, objects, dispatcher } = build(env, `${url.protocol}//${url.host}`);
      // Object bytes: the Worker-served equivalent of presigned URLs (bearer token, one key, one method).
      const m = /^\/_forge\/objects\/([^/]+)$/.exec(url.pathname);
      if (m && objects) return objects.serve(request, m[1]!);
      const handler = createHttpHandler(model, engine, { auth, requestId: (req) => req.headers.get("cf-ray") ?? crypto.randomUUID(), ...(env.FORGE_CORS ? { cors: { origins: env.FORGE_CORS.split(",") } } : {}) });
      const res = await handler(request);
      // Prompt post-commit nudge for this tenant; the cron sweep is the guarantee.
      if (ctx && request.method !== "GET" && res.status < 300) {
        const tenant = request.headers.get("x-forge-tenant");
        if (tenant) ctx.waitUntil(Effect.runPromise(dispatcher.sweep(tenant, { now: Date.now() })).catch(() => undefined));
      }
      return res;
    },
  };
}
