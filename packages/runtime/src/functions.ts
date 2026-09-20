/**
 * Implemented functions (plan §5.4, §8). The application supplies bodies with
 * defineFunction(); the runtime constructs a FunctionContext exposing exactly
 * the declared dependencies. Publications are staged and committed with the
 * function's next mutation (or in a final outbox-only commit), never sent
 * directly.
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import { canonicalize } from "./decode.js";
import { sha256, stableJson, type CallContext, type Engine } from "./engine.js";
import { err, ForgeError } from "./errors.js";
import type { FunctionDecl, Resource } from "./model.js";
import { Clock, IdGen, Storage, type CommitPlan, type OutboxEntry, type RuntimeServices } from "./services.js";
import type { Envelope } from "./dispatch.js";

export type ExternalResult = { ok: true; value: any } | { ok: false; code: string; detail?: string };
export type ExternalBinding = (input: unknown, ctx: CallContext) => Promise<ExternalResult>;

export interface ResourceReader {
  get(id: string): Effect.Effect<Wire, ForgeError>;
  find(query: string, params: Wire): Effect.Effect<Wire, ForgeError>;
  list(query: string, params: Wire, page?: { cursor?: string; limit?: number }): Effect.Effect<Wire, ForgeError>;
}
export interface ResourceWriter extends ResourceReader {
  create(input: Wire): Effect.Effect<Wire, ForgeError>;
  update(id: string, expectedVersion: number, patch: Wire): Effect.Effect<Wire, ForgeError>;
  delete(id: string, expectedVersion: number): Effect.Effect<Wire, ForgeError>;
}

export interface FunctionContext {
  readonly input: unknown;
  readonly ctx: CallContext;
  /** Declared resource capabilities, by resource name. Capability decides which methods exist. */
  readonly resources: Record<string, ResourceWriter>;
  /** Declared transitions: transitions.Order.submit(id, expectedVersion, input). */
  readonly transitions: Record<string, Record<string, (id: string, expectedVersion: number, input: Wire) => Effect.Effect<Wire, ForgeError>>>;
  /** Declared external callables, by stable id. */
  external(id: string, input: unknown): Effect.Effect<ExternalResult, ForgeError>;
  /** Stage a declared message. Delivered with the function's commit. */
  send(channel: string, message: string, payload: Wire): Effect.Effect<void, ForgeError>;
  /** Fail with a declared domain error. */
  fail(name: string, detail?: string): Effect.Effect<never, ForgeError>;
}

export interface FunctionImpl {
  id: string;
  body: (deps: FunctionContext) => Effect.Effect<Wire | void, ForgeError, never>;
}

export function defineFunction(id: string, body: (deps: FunctionContext) => Effect.Effect<Wire | void, ForgeError, never>): FunctionImpl {
  return { id, body };
}

export class Functions {
  private readonly impls = new Map<string, FunctionImpl>();
  constructor(private readonly engine: Engine, impls: FunctionImpl[], private readonly externals: Record<string, ExternalBinding>) {
    for (const i of impls) this.impls.set(i.id, i);
  }

  has(id: string): boolean {
    return this.impls.has(id);
  }

  invoke(decl: FunctionDecl, input: unknown, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const impl = this.impls.get(decl.id);
    if (!impl) return Effect.fail(err("Internal", `no implementation registered for ${decl.id}; add one under impl/ (a production build refuses to deploy without it)`));
    const self = this;
    return Effect.gen(function* () {
      // A function's own writes and its publications form ONE atomic commit at the end of the body
      // (plan §9 step 6). Reads inside the body see committed state; planned writes are validated
      // against current state when the body finishes and committed together, or not at all.
      const pending: OutboxEntry[] = [];
      const plans: CommitPlan[] = [];
      const deps = self.context(decl, input, ctx, pending, plans);
      const result = yield* impl.body(deps).pipe(Effect.provide(self.engine.layer));
      if (plans.length || pending.length) {
        const storage = yield* Storage;
        const now = (yield* Clock).now();
        const opId = plans[0]?.opId ?? (yield* IdGen).opId();
        const host = plans[0];
        const outbox = pending.map((p, i) => ({ ...p, opId, ordinal: (host?.outbox.length ?? 0) + i, createdAt: now }));
        if (host) {
          // An idempotency key stores the function's result with its first plan: a replay returns it
          // instead of re-running the body (plan §15 activity retries rely on this).
          const receipt = ctx.idempotencyKey
            ? { receipt: { tenant: ctx.tenant, operation: decl.id, key: ctx.idempotencyKey, requestHash: yield* Effect.promise(() => sha256(stableJson((input ?? {}) as Wire))), status: 200, response: (result ?? {}) as Wire, createdAt: now } }
            : {};
          plans[0] = { ...host, outbox: [...host.outbox, ...outbox], ...receipt };
          yield* storage.commitAll(plans);
        } else {
          yield* self.commitOutboxOnly(decl, ctx, outbox);
        }
      }
      return (result ?? {}) as Wire;
    });
  }

  private context(decl: FunctionDecl, input: unknown, ctx: CallContext, pending: OutboxEntry[], plans: CommitPlan[]): FunctionContext {
    const engine = this.engine;
    const layer = engine.layer;
    const run = <A>(e: Effect.Effect<A, ForgeError, RuntimeServices>): Effect.Effect<A, ForgeError> => e.pipe(Effect.provide(layer));
    const resources: Record<string, ResourceWriter> = {};
    const transitions: Record<string, Record<string, (id: string, expectedVersion: number, input: Wire) => Effect.Effect<Wire, ForgeError>>> = {};
    const externalIds = new Set<string>();

    // Plan now (validation, version check against current state), commit with the function at the end.
    const mutate = (op: string, body: Wire) =>
      run(
        Effect.gen(function* () {
          const plan = yield* engine.planFor(op, body, ctx);
          plans.push(plan);
          return engine.resultOf(plan);
        }),
      );

    for (const u of decl.uses) {
      if (u.kind === "resource") {
        const r = engine.model.resource(u.resource);
        const reader: ResourceReader = {
          get: (id) => run(engine.callInternal(`${r.id}.get`, { id }, ctx)),
          find: (q, params) => run(engine.callInternal(`${r.id}.find.${q}`, { params }, ctx)),
          list: (q, params, page) => run(engine.callInternal(`${r.id}.list.${q}`, { params, ...page }, ctx)),
        };
        const cap = u.capability;
        const writer: ResourceWriter = {
          ...reader,
          create: (input) => (cap === "create" || cap === "write" ? mutate(`${r.id}.create`, input) : Effect.fail(err("Forbidden", `${decl.name} did not declare create on ${r.name}`))),
          update: (id, expectedVersion, patch) => (cap === "write" ? mutate(`${r.id}.update`, { id, expectedVersion, patch }) : Effect.fail(err("Forbidden", `${decl.name} did not declare write on ${r.name}`))),
          delete: (id, expectedVersion) => (cap === "delete" || cap === "write" ? mutate(`${r.id}.delete`, { id, expectedVersion }) : Effect.fail(err("Forbidden", `${decl.name} did not declare delete on ${r.name}`))),
        };
        resources[r.name] = writer;
      } else if (u.kind === "transition") {
        const r = engine.model.resource(u.resource);
        transitions[r.name] ??= {};
        transitions[r.name]![u.action] = (id, expectedVersion, input) => mutate(`${r.id}.status.${u.action}`, { id, expectedVersion, input });
        // a transition implies reading the resource
        resources[r.name] ??= { get: (id) => run(engine.callInternal(`${r.id}.get`, { id }, ctx)), find: () => Effect.fail(err("Forbidden", "not declared")), list: () => Effect.fail(err("Forbidden", "not declared")), create: () => Effect.fail(err("Forbidden", "not declared")), update: () => Effect.fail(err("Forbidden", "not declared")), delete: () => Effect.fail(err("Forbidden", "not declared")) };
      } else {
        externalIds.add(u.function);
      }
    }
    const self = this;
    const allowedSends = new Set(decl.sends.map((s) => `${s.channel}#${s.message}`));
    return {
      input,
      ctx,
      resources,
      transitions,
      external: (id, i) => {
        if (!externalIds.has(id)) return Effect.fail(err("Forbidden", `${decl.name} did not declare a dependency on ${id}`));
        const binding = self.externals[id];
        if (!binding) return Effect.fail(err("DependencyUnavailable", `no binding for external ${id}`));
        return Effect.tryPromise({ try: () => binding(i, ctx), catch: (e) => err("DependencyUnavailable", String((e as Error).message ?? e)) });
      },
      send: (channelRef, message, payload) => {
        const ch = engine.model.channel(channelRef);
        if (!ch) return Effect.fail(err("Forbidden", `unknown channel ${channelRef}`));
        if (!allowedSends.has(`${ch.id}#${message}`)) return Effect.fail(err("Forbidden", `${decl.name} may not send ${message} to ${channelRef}; declare it under sends { }`));
        if (ch.direction === "recv-only") return Effect.fail(err("Forbidden", `${channelRef} is recv-only`));
        pending.push({ tenant: ctx.tenant, opId: "", ordinal: 0, channel: ch.id, message, payload, createdAt: "" });
        return Effect.void;
      },
      fail: (name, detail) => {
        if (!decl.errors.includes(name)) return Effect.fail(err("Internal", `${decl.name} raised undeclared error ${name}`));
        return Effect.fail(new ForgeError({ code: `${decl.id}.${name}`, ...(detail ? { detail } : {}) }));
      },
    };
  }

  private commitOutboxOnly(decl: FunctionDecl, ctx: CallContext, outbox: OutboxEntry[]): Effect.Effect<void, ForgeError, RuntimeServices> {
    const engine = this.engine;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const first = outbox[0]!;
      // A commit with no record change: adapters treat `kind: "publish"` as outbox + audit only.
      const r = engine.model.resources[0] as Resource;
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId: first.opId, actor: ctx.actor, at: first.createdAt, resource: r, kind: "publish", id: decl.id, expectedVersion: null, before: null, after: {},
        claims: [], references: [], dependents: [], hardDelete: false,
        audit: { tenant: ctx.tenant, opId: first.opId, resource: decl.id, recordId: decl.id, kind: "function.publish", newVersion: null, actor: ctx.actor, at: first.createdAt },
        outbox,
      };
      yield* storage.commit(plan);
    });
  }

  /** Subscription consumer: dedup by messageId, then invoke the handler with the message payload as input. */
  async consume(subscription: string, env: Envelope): Promise<"processed" | "duplicate" | "unknown-subscription"> {
    const sub = this.engine.model.subscription(subscription);
    if (!sub) return "unknown-subscription";
    const decl = this.engine.model.function(sub.handler);
    if (!decl) return "unknown-subscription";
    const storage = await Effect.runPromise(Effect.service(Storage).pipe(Effect.provide(this.engine.layer)));
    const fresh = await Effect.runPromise(storage.markProcessed(env.tenant, subscription, env.messageId));
    if (!fresh) return "duplicate";
    const ctx: CallContext = { tenant: env.tenant, actor: `subscription:${subscription}`, requestId: env.messageId };
    await Effect.runPromise(this.invoke(decl, env.payload, ctx).pipe(Effect.provide(this.engine.layer)));
    return "processed";
  }
}

export { canonicalize };
