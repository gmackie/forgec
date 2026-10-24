/** Cloudflare Workers host: builds the runtime Layer from bindings per invocation. */
import { Effect, Layer } from "effect";
import { D1Storage, type D1Like } from "../adapters/d1.js";
import { R2ObjectStore, type R2Like } from "../adapters/r2.js";
import { EngineCore } from "../engine.js";
import { createHttpHandler, devHeaderAuth, type AuthHost, type SignedWebhook, type HttpEndpoint } from "../http.js";
import { Model, type AppBundle } from "../model.js";
import type { Instance, WorkflowDriver } from "../workflows.js";
import { SessionProtocol, upgradeAuthRequest, type EventFrame, type RealtimeHub } from "../realtime.js";
import { workersLogLine } from "../telemetry.js";
import type { WorkflowDecl } from "../model.js";
import { cloudflareQueuesTransport, decodeEnvelope, type QueueLike } from "../transports.js";
import type { EngineOptions } from "../engine.js";
import { Clock, CursorSecret, IdGen, Objects, Storage, type ObjectStoreAdapter } from "../services.js";
import { productionIds } from "./ids.js";
import { MemoryObjectStore } from "../adapters/memory-objects.js";
import { allFeatures, checkFeatures, type Feature } from "../features.js";
import { capabilityDenied } from "../errors.js";

/** Cloudflare Workflows binding surface used by the driver. */
export interface WorkflowBindingLike {
  create(opts: { id: string; params: unknown }): Promise<unknown>;
  get(id: string): Promise<{ sendEvent(e: { type: string; payload: unknown }): Promise<void> }>;
}

/** Durable Object namespace surface used for realtime streams. */
export interface RealtimeNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}

export interface WorkerEnv {
  DB: D1Like;
  /** Realtime Durable Object namespace (bundle.realtime.cloudflare.binding). */
  REALTIME?: RealtimeNamespaceLike;
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
  endpoints?: HttpEndpoint[] | ((env: WorkerEnv) => HttpEndpoint[]);
  /** Explicit signed webhook POST bindings; never authenticates normal API routes. */
  webhooks?: Record<string, SignedWebhook> | ((env: WorkerEnv) => Record<string, SignedWebhook>);
  /**
   * Replaces the in-process post-commit outbox nudge. The local dispatcher delivers each outbox row to
   * the subscriptions *this* model knows and then marks the row done, so a Worker running a slice of
   * the app (FORG-29 packed linker) must hand the nudge to a Worker that holds the whole subscription
   * table instead of sweeping itself. Unset: sweep locally, as a whole-app Worker always has.
   */
  postCommit?: (env: WorkerEnv, tenant: string) => Promise<unknown>;
  /** Which sweeps a cron invocation runs (default: all three). A Worker that owns only a schedule runs only `schedules`. */
  sweeps?: { outbox?: boolean; schedules?: boolean; workflows?: boolean };
  /** Blob storage (default for `createWorker`: `cloudflareObjects`). */
  objects?: WorkerObjects;
}

/** A Worker's blob storage: the store behind `Objects` and, when the Worker serves bytes itself, the `/_forge/objects` route. */
export type WorkerObjects = (env: WorkerEnv, baseUrl: string) => { store: ObjectStoreAdapter; serve?: (request: Request, token: string) => Promise<Response> };

/** R2 when `BLOBS` is bound (bytes served by the Worker), otherwise in memory: the whole-app Worker's blob storage. */
export const cloudflareObjects: WorkerObjects = (env, baseUrl) => {
  if (!env.BLOBS) return { store: new MemoryObjectStore() };
  const r2 = new R2ObjectStore(env.BLOBS, { baseUrl, secret: env.CURSOR_SECRET });
  return { store: r2, serve: (request, token) => r2.serve(request, token) };
};

/**
 * Options for a Worker built from named features (FORG-37): exactly `features` are linked, so the
 * bundle carries only their code. `objects` is required when `blobs` is linked; without it the
 * `Objects` service refuses every call.
 */
export interface FeatureWorkerOptions extends WorkerOptions {
  features: readonly Feature[];
}

/**
 * The `Objects` service of a Worker linked without blob storage. Unreachable through the model (a model
 * with blob resources needs the blobs feature, which needs `objects`), so a call is a linking defect and
 * is refused like any capability the Worker is not linked with: 403 `CapabilityDenied` (FORG-34).
 */
const unlinkedObjects: ObjectStoreAdapter = (() => {
  const refuse = () => Effect.fail(capabilityDenied({ capability: "objects", detail: "blob storage is not linked into this Worker" }));
  return { name: "unlinked", presignUpload: refuse, head: refuse, digest: refuse, seal: refuse, presignDownload: refuse, delete: refuse };
})();

/** What `createWorker` and friends link: every feature and the whole-app blob storage. */
const whole = <O extends WorkerOptions>(options: O): O & FeatureWorkerOptions => ({ ...options, features: options.features ?? allFeatures, objects: options.objects ?? cloudflareObjects });

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

/** One Durable Object per (tenant, stream) holds the live sockets; the Worker posts frames to it. */
function cloudflareRealtimeHub(env: WorkerEnv): RealtimeHub | null {
  if (!env.REALTIME) return null;
  const ns = env.REALTIME;
  return {
    async broadcast(tenant, channel, frame: EventFrame) {
      const stub = ns.get(ns.idFromName(`${tenant}|${channel}`));
      await stub.fetch("https://realtime/broadcast", { method: "POST", body: JSON.stringify(frame), headers: { "content-type": "application/json" } });
    },
  };
}

/**
 * The Durable Object body for realtime streams (`Base` is `DurableObject` from `cloudflare:workers`).
 * Uses the WebSocket hibernation API: sockets survive the object being evicted, their subscription
 * state lives in the socket attachment, and the session protocol is the shared one.
 */
export function createRealtimeObject<B extends abstract new (...args: any[]) => any>(Base: B, bundle: AppBundle, options: WorkerOptions = {}) {
  return createRealtimeObjectWith(Base, bundle, whole({ objects: () => ({ store: new MemoryObjectStore() }), ...options }));
}

/** `createRealtimeObject` with exactly `options.features` linked (FORG-37). */
export function createRealtimeObjectWith<B extends abstract new (...args: any[]) => any>(Base: B, bundle: AppBundle, options: FeatureWorkerOptions) {
  const model = new Model(bundle);
  checkFeatures(model, options.features);
  abstract class ForgeRealtimeObject extends Base {
    engineFor(env: WorkerEnv): EngineCore {
      const storage = new D1Storage(env.DB, model);
      const layer = Layer.mergeAll(
        Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
        Layer.succeed(IdGen)(productionIds()),
        Layer.succeed(Storage)(storage),
        Layer.succeed(CursorSecret)({ key: env.CURSOR_SECRET }),
        Layer.succeed(Objects)(options.objects?.(env, "https://realtime.invalid").store ?? unlinkedObjects),
      );
      return new EngineCore(model, layer, options);
    }
    async fetch(request: Request): Promise<Response> {
      const self = this as unknown as { ctx: { acceptWebSocket(ws: WebSocket, tags?: string[]): void; getWebSockets(tag?: string): WebSocket[] }; env: WorkerEnv };
      const url = new URL(request.url);
      if (url.pathname === "/broadcast") {
        const frame = (await request.json()) as EventFrame;
        const text = JSON.stringify(frame);
        for (const ws of self.ctx.getWebSockets()) {
          const att = (ws as unknown as { deserializeAttachment(): { streams?: string[] } | null }).deserializeAttachment() ?? {};
          if (att.streams?.includes(frame.stream)) {
            try { ws.send(text); } catch { /* closing socket: the client resumes by position */ }
          }
        }
        return new Response(null, { status: 204 });
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      const tenant = request.headers.get("x-forge-tenant") ?? url.searchParams.get("tenant") ?? "";
      const pair = new (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, WebSocket> }).WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      (server as unknown as { serializeAttachment(v: unknown): void }).serializeAttachment({ tenant, streams: [] });
      self.ctx.acceptWebSocket(server, [tenant]);
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    }
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      const self = this as unknown as { env: WorkerEnv };
      const sock = ws as unknown as { deserializeAttachment(): { tenant: string; streams?: string[] }; serializeAttachment(v: unknown): void };
      const att = sock.deserializeAttachment();
      const session = new SessionProtocol(this.engineFor(self.env), att.tenant);
      session.restore(att.streams ?? []);
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      const replies = await session.handle(text);
      sock.serializeAttachment({ tenant: att.tenant, streams: session.streams() });
      for (const r of replies) ws.send(JSON.stringify(r));
    }
    async webSocketClose(ws: WebSocket, code: number): Promise<void> {
      try { ws.close(code, "closed"); } catch { /* already closed */ }
    }
  }
  return ForgeRealtimeObject;
}

/**
 * The WorkflowEntrypoint body for one Forge workflow: `run` loops the portable executor with
 * durable `step.do` calls, `step.sleep` for sleeps, and `step.waitForEvent` (bounded by the wait's
 * deadline) for waits. `Base` is `WorkflowEntrypoint` from `cloudflare:workers`, passed in so this
 * module stays importable outside the Workers runtime.
 */
export function createWorkflowEntrypoint<B extends abstract new (...args: any[]) => any>(Base: B, bundle: AppBundle, options: WorkerOptions = {}) {
  return createWorkflowEntrypointWith(Base, bundle, whole(options));
}

/** `createWorkflowEntrypoint` with exactly `options.features` linked (FORG-37); `workflows` must be one. */
export function createWorkflowEntrypointWith<B extends abstract new (...args: any[]) => any>(Base: B, bundle: AppBundle, options: FeatureWorkerOptions) {
  const worker = createWorkerWith(bundle, options);
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
        } else if (state.status === "running") {
          // Another driver may own a mapped child lease. Yield before polling again.
          await step.sleep(`retry:${n}`, 1000);
        } else {
          return state;
        }
      }
      return null;
    }
  }
  return ForgeWorkflowEntrypoint;
}

/** The whole-app Worker: every feature linked, R2 (or memory) blob storage. */
export function createWorker(bundle: AppBundle, options: WorkerOptions = {}) {
  return createWorkerWith(bundle, whole(options));
}

/**
 * A Worker with exactly `options.features` linked (FORG-37): what a packed script running a slice of
 * the app uses, so it bundles only the features its slice needs. A Worker without the `dispatch`
 * feature cannot sweep its outbox, so it must hand post-commit work elsewhere (`postCommit`) and not
 * run the outbox sweep. Throws when the model needs a feature that is not linked.
 */
export function createWorkerWith(bundle: AppBundle, options: FeatureWorkerOptions) {
  const model = new Model(bundle);
  checkFeatures(model, options.features);
  const sweeps = { outbox: true, schedules: true, workflows: true, ...options.sweeps };
  const names = new Set(options.features.map((f) => f.name));
  if (!names.has("dispatch") && (!options.postCommit || sweeps.outbox)) throw new Error("forge: a Worker without the dispatch feature needs postCommit and sweeps.outbox: false");
  if (names.has("blobs") && !options.objects) throw new Error("forge: a Worker with the blobs feature needs objects (blob storage)");
  // Tenants already recorded in the schedule index by this isolate (FORG-3); a miss costs one point read.
  const tracked = new Set<string>();

  const build = (env: WorkerEnv, baseUrl: string) => {
    const objects = options.objects?.(env, baseUrl) ?? null;
    const storage = new D1Storage(env.DB, model);
    const layer = Layer.mergeAll(
      Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
      Layer.succeed(IdGen)(productionIds()),
      Layer.succeed(Storage)(storage),
      Layer.succeed(CursorSecret)({ key: env.CURSOR_SECRET }),
      Layer.succeed(Objects)(objects?.store ?? unlinkedObjects),
    );
    const engine = new EngineCore(model, layer, options);
    const workflows = engine.feature("workflows");
    if (workflows) workflows.driver = cloudflareWorkflowDriver(model, env);
    const realtime = engine.feature("realtime");
    if (realtime) realtime.hub = cloudflareRealtimeHub(env);
    // Workers Logs: structured JSON per operation event (plan §20; metrics are derived downstream).
    engine.telemetry.target = "cloudflare-d1";
    engine.telemetry.sink = { write: (e) => console.log(workersLogLine(e)) };
    const dispatcher = engine.feature("dispatch")?.dispatcher(storage, cloudflareQueuesTransport(queueBindings(model, env)), { leaseMs: 30_000, maxAttempts: 8 }) ?? null;
    return { engine, storage, objects, dispatcher };
  };
  const needDispatcher = <T>(d: T | null): T => {
    if (!d) throw new Error("forge: the dispatch feature is not linked into this Worker");
    return d;
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
      // FORG-3: the schedule index, not the outbox, decides which tenants are due (idle and global ones included).
      const ev = (event ?? {}) as { cron?: string; scheduledTime?: number };
      const now = new Date(ev.scheduledTime ?? Date.now()).toISOString();
      // A feature that is not linked has nothing to sweep: the model does not use it (EngineCore checks).
      const schedules = engine.feature("schedules");
      const workflows = engine.feature("workflows");
      if (sweeps.schedules && schedules) ctx.waitUntil(Effect.runPromise(schedules.sweep(now, tenants)));
      if (sweeps.outbox) ctx.waitUntil(Promise.all(tenants.map((t: string) => Effect.runPromise(needDispatcher(dispatcher).sweep(t, { now: Date.now() })))));
      // Crashed `running` instances resume here; native drivers own timers.
      if (sweeps.workflows && workflows) ctx.waitUntil(Promise.all(tenants.map((t: string) => Effect.runPromise(workflows.sweep(t)))));
    },
    /**
     * What a whole-app Worker does after a request, run on behalf of a Worker that holds only a slice:
     * record the tenant in the schedule index and, for a committed write, sweep the tenant's outbox.
     */
    async dispatch(env: WorkerEnv, tenant: string, o: { sweep: boolean }): Promise<void> {
      const { engine, dispatcher } = build(env, "https://dispatch.invalid");
      const schedules = engine.feature("schedules");
      if (schedules?.active && !tracked.has(tenant)) {
        tracked.add(tenant);
        await Effect.runPromise(schedules.track(tenant));
      }
      if (o.sweep) await Effect.runPromise(needDispatcher(dispatcher).sweep(tenant, { now: Date.now() }));
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
      if (auth?.scheme === "dev-header") console.warn("forge: DEVELOPMENT AUTH ACTIVE — x-forge-tenant/x-forge-actor headers are trusted verbatim. Never expose this deployment to untrusted callers.");
      if (!auth) return new Response(JSON.stringify({ code: "Unauthenticated", detail: "no authentication host configured (set FORGE_AUTH=dev-headers for development)" }), { status: 401, headers: { "content-type": "application/problem+json" } });
      const url = new URL(request.url);
      const { engine, objects, dispatcher } = build(env, `${url.protocol}//${url.host}`);
      // Realtime upgrade: authenticate (query-string headers for browsers), then hand the socket to the stream's object.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const stream = engine.feature("realtime")?.streamByPath(url.pathname);
        if (!stream || !env.REALTIME) return new Response("no such stream", { status: 404 });
        const principal = await auth.authenticate(upgradeAuthRequest(url, request.headers));
        if (!("tenant" in principal)) return new Response(JSON.stringify(principal.problem(crypto.randomUUID())), { status: 401, headers: { "content-type": "application/problem+json" } });
        const stub = env.REALTIME.get(env.REALTIME.idFromName(`${principal.tenant}|${stream.channel}`));
        const forwarded = new Request(request.url, request);
        forwarded.headers.set("x-forge-tenant", principal.tenant);
        forwarded.headers.set("x-forge-actor", principal.actor);
        return stub.fetch(forwarded);
      }
      // Object bytes: the Worker-served equivalent of presigned URLs (bearer token, one key, one method).
      const m = /^\/_forge\/objects\/([^/]+)$/.exec(url.pathname);
      if (m && objects?.serve) return objects.serve(request, m[1]!);
      const schedules = engine.feature("schedules");
      const observeTenant = (tenant: string) => {
        if (tracked.has(tenant) || !schedules?.active) return;
        tracked.add(tenant);
        const p = Effect.runPromise(schedules.track(tenant));
        if (ctx) ctx.waitUntil(p);
      };
      const webhooks = typeof options.webhooks === "function" ? options.webhooks(env) : options.webhooks;
      const signedWebhook = request.method === "POST" && webhooks && Object.hasOwn(webhooks, url.pathname);
      const endpoints = typeof options.endpoints === "function" ? options.endpoints(env) : options.endpoints;
      const handler = createHttpHandler(model, engine, { auth, observeTenant, ...(endpoints ? { endpoints } : {}), ...(webhooks ? { webhooks } : {}), requestId: (req) => req.headers.get("cf-ray") ?? crypto.randomUUID(), ...(env.FORGE_CORS ? { cors: { origins: env.FORGE_CORS.split(",") } } : {}) });
      const res = await handler(request);
      // Prompt post-commit nudge for this tenant; the cron sweep is the guarantee.
      if (ctx && !signedWebhook && request.method !== "GET" && res.status < 300) {
        const tenant = request.headers.get("x-forge-tenant");
        if (tenant) ctx.waitUntil((options.postCommit ? options.postCommit(env, tenant) : Effect.runPromise(needDispatcher(dispatcher).sweep(tenant, { now: Date.now() }))).catch(() => undefined));
      }
      return res;
    },
  };
}
