/** Cloudflare Workers host: builds the runtime Layer from bindings per invocation. */
import { Effect, Layer } from "effect";
import { D1Storage, type D1Like } from "../adapters/d1.js";
import { R2ObjectStore, type R2Like } from "../adapters/r2.js";
import { Engine } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import { Dispatcher } from "../dispatch.js";
import { internalSubscriptions, withProjections } from "../readmodels.js";
import type { Instance, WorkflowDriver } from "../workflows.js";
import type { WorkflowDecl } from "../model.js";
import { cloudflareQueuesTransport, decodeEnvelope, type QueueLike } from "../transports.js";
import type { EngineOptions } from "../engine.js";
import { Clock, CursorSecret, IdGen, Objects, Storage } from "../services.js";
import { productionIds } from "./ids.js";
import { MemoryObjectStore } from "../adapters/memory-objects.js";

/** Cloudflare Workflows binding surface used by the driver. */
export interface WorkflowBindingLike {
  create(opts: { id: string; params: unknown }): Promise<unknown>;
  get(id: string): Promise<{ sendEvent(e: { type: string; payload: unknown }): Promise<void> }>;
}

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

function nativeId(tenant: string, id: string): string {
  return `${tenant}-${id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
}

/** Cloudflare Workflows drives instances: one native instance per Forge instance, `sendEvent` wakes waits. */
function cloudflareWorkflowDriver(model: Model, env: WorkerEnv): WorkflowDriver | null {
  const plans = model.bundle.workflows?.workflows ?? [];
  if (!plans.length) return null;
  const binding = (wf: WorkflowDecl) => env[plans.find((p) => p.id === wf.id)?.cloudflare.binding ?? ""] as WorkflowBindingLike | undefined;
  return {
    async started(tenant, wf, instanceId) {
      const b = binding(wf);
      if (!b) return; // no binding configured: the cron sweep remains the timer
      // Workflows instance ids: URL-safe, no colons.
      await b.create({ id: nativeId(tenant, instanceId), params: { tenant, id: instanceId } });
    },
    async wake(tenant, wf, inst: Instance) {
      const b = binding(wf);
      if (!b) return;
      try {
        const i = await b.get(nativeId(tenant, inst.id));
        await i.sendEvent({ type: "forge.wake", payload: { at: new Date().toISOString() } });
      } catch {
        // An instance that already finished (or never started natively) has nothing to wake.
      }
    },
  };
}

/**
 * The WorkflowEntrypoint body for one Forge workflow: `run` loops the portable executor with
 * durable `step.do` calls, `step.sleep` for sleeps, and `step.waitForEvent` (bounded by the wait's
 * deadline) for waits. `Base` is `WorkflowEntrypoint` from `cloudflare:workers`, passed in so this
 * module stays importable outside the Workers runtime.
 */
export function createWorkflowEntrypoint<B extends abstract new (...args: any[]) => any>(Base: B, bundle: AppBundle, options: WorkerOptions = {}) {
  const worker = createWorker(bundle, options);
  abstract class ForgeWorkflowEntrypoint extends Base {
    async run(event: { payload: { tenant: string; id: string } }, step: { do<T>(name: string, fn: () => Promise<T>): Promise<T>; sleep(name: string, ms: number): Promise<void>; waitForEvent(name: string, opts: { type: string; timeout?: string | number }): Promise<unknown> }) {
      const env = (this as unknown as { env: WorkerEnv }).env;
      const { tenant, id } = event.payload;
      for (let n = 0; n < 10_000; n++) {
        const state = await step.do(`advance:${n}`, () => worker.advance(env, tenant, id));
        if (state.status === "sleeping") {
          await step.sleep(`sleep:${n}`, Math.max(0, Date.parse(state.dueAt!) - Date.now()));
        } else if (state.status === "waiting") {
          const timeout = state.dueAt ? Math.max(1000, Date.parse(state.dueAt) - Date.now()) : 365 * 24 * 3600 * 1000;
          try {
            await step.waitForEvent(`wait:${n}`, { type: "forge.wake", timeout });
          } catch {
            // Deadline reached: the next advance applies the timeout terminal (or a late signal already consumed).
          }
        } else if (state.status !== "running") {
          return state;
        }
      }
      return null;
    }
  }
  return ForgeWorkflowEntrypoint;
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
    engine.workflows.driver = cloudflareWorkflowDriver(model, env);
    const dispatcher = new Dispatcher(model, storage, withProjections(engine, cloudflareQueuesTransport(queueBindings(model, env))), { subscriptions: internalSubscriptions(engine, subscriptions), leaseMs: 30_000, maxAttempts: 8 });
    return { engine, storage, objects, dispatcher };
  };

  return {
    /** One driver step for the Workflows entrypoint: advance and report where the instance parked. */
    async advance(env: WorkerEnv, tenant: string, id: string): Promise<{ status: string; dueAt?: string }> {
      const { engine } = build(env, "https://workflow.invalid");
      const st = await Effect.runPromise(engine.workflows.advance(tenant, id).pipe(Effect.provide(engine.layer)));
      const dueAt = ((st["sleeping"] as { dueAt?: string } | undefined)?.dueAt ?? (st["waiting"] as { dueAt?: string } | undefined)?.dueAt) as string | undefined;
      return { status: st["status"] as string, ...(dueAt ? { dueAt } : {}) };
    },
    /** Cron trigger: the durable outbox sweep (plan §14: waitUntil nudges are not a delivery guarantee). */
    async scheduled(event: { cron?: string; scheduledTime?: number } | unknown, env: WorkerEnv, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
      const { storage, dispatcher, engine } = build(env, "https://scheduled.invalid");
      const tenants = await Effect.runPromise(storage.outboxTenants());
      // Schedules (plan §19): the trigger's scheduledTime is the intended instant; the ledger decides what is due.
      const ev = (event ?? {}) as { cron?: string; scheduledTime?: number };
      const now = new Date(ev.scheduledTime ?? Date.now()).toISOString();
      ctx.waitUntil(Promise.all(tenants.map((t: string) => Effect.runPromise(engine.schedules.tick(t, now)))));
      ctx.waitUntil(Promise.all(tenants.map((t: string) => Effect.runPromise(dispatcher.sweep(t, { now: Date.now() })))));
      // Crashed `running` instances resume here; native drivers own timers.
      ctx.waitUntil(Promise.all(tenants.map((t: string) => Effect.runPromise(engine.workflows.sweep(t)))));
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
