/**
 * Implemented functions (plan §5.4, §8). The application supplies bodies with
 * defineFunction(); the runtime constructs a FunctionContext exposing exactly
 * the declared dependencies. Writes and publications are staged for a final
 * atomic commit. Transactional functions additionally read their staged records.
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import { canonicalize } from "./decode.js";
import { sha256, stableJson, type CallContext, type Engine } from "./engine.js";
import { err, ForgeError } from "./errors.js";
import type { FunctionDecl, Resource } from "./model.js";
import { Clock, IdGen, Storage, type CommitPlan, type OutboxEntry, type RuntimeServices } from "./services.js";
import { SubscriptionDelivery } from "./subscription-delivery.js";
import type { Envelope } from "./dispatch.js";
import { TransactionView, lowerTransaction } from "./transaction.js";

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
  /** Opt in to staged point reads, references and bounded sequential updates. */
  transactional?: boolean;
}

export function defineFunction(id: string, body: (deps: FunctionContext) => Effect.Effect<Wire | void, ForgeError, never>, options: { transactional?: boolean } = {}): FunctionImpl {
  return { id, body, ...options };
}

export class Functions {
  private readonly impls = new Map<string, FunctionImpl>();
  constructor(private readonly engine: Engine, impls: FunctionImpl[], private readonly externals: Record<string, ExternalBinding>) {
    for (const i of impls) this.impls.set(i.id, i);
  }

  has(id: string): boolean {
    return this.impls.has(id);
  }

  invoke(decl: FunctionDecl, input: unknown, ctx: CallContext, delivery?: SubscriptionDelivery): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const impl = this.impls.get(decl.id);
    if (!impl) return Effect.fail(err("Internal", `no implementation registered for ${decl.id}; add one under impl/ (a production build refuses to deploy without it)`));
    const self = this;
    return Effect.gen(function* () {
      // A function's writes, receipt and publications form ONE final commit.
      const storage = yield* Storage;
      if (impl.transactional && (!storage.atomicComposition || !storage.atomicReadSet)) return yield* Effect.fail(err("ValidationFailed", "Storage profile does not support transactional functions"));
      const view = impl.transactional ? new TransactionView(storage) : undefined;
      const pending: OutboxEntry[] = [];
      let plans: CommitPlan[] = view?.plans ?? [];
      const lifecycle = { active: true, busy: false };
      const deps = self.context(decl, input, ctx, pending, plans, delivery, view, lifecycle);
      const result = yield* impl.body(deps).pipe(Effect.provide(self.engine.layer), Effect.ensuring(Effect.sync(() => { lifecycle.active = false; })));
      if (view && lifecycle.busy) return yield* Effect.fail(err("ValidationFailed", "Function body must await every resource call"));
      if (view) plans = yield* lowerTransaction(plans, !!storage.atomicReadSet);
      if (plans.length || pending.length || delivery || (view && ctx.idempotencyKey)) {
        const now = (yield* Clock).now();
        const opId = plans[0]?.opId ?? (yield* IdGen).opId();
        const host = plans[0];
        const outbox = pending.map((p, i) => ({ ...p, opId, ordinal: (host?.outbox.length ?? 0) + i, createdAt: now, ...(ctx.trace ? { trace: ctx.trace } : {}) }));
        if (host) {
          // An idempotency key stores the function's result with its first plan: a replay returns it
          // instead of re-running the body (plan §15 activity retries rely on this).
          const receipt = ctx.idempotencyKey
            ? { receipt: { tenant: ctx.tenant, operation: decl.id, key: ctx.idempotencyKey, requestHash: yield* Effect.promise(() => sha256(stableJson((input ?? {}) as Wire))), status: 200, response: (result ?? {}) as Wire, createdAt: now } }
            : {};
          plans[0] = { ...host, outbox: [...host.outbox, ...outbox], ...receipt, ...(delivery ? { completion: delivery.completion() } : {}) };
          if (view) {
            const budget = storage.budget(plans, [], view.reads);
            if (budget.actions > budget.limit) return yield* Effect.fail(err("BudgetExceeded", "Transactional function exceeds provider action budget"));
          }
          yield* storage.commitAll(plans, [], view?.reads);
        } else {
          yield* self.commitOutboxOnly(decl, ctx, outbox, opId, now, delivery, view ? { result: (result ?? {}) as Wire, input: (input ?? {}) as Wire, reads: view.reads } : undefined);
        }
      }
      if (view && !plans.length && !pending.length && !delivery && !ctx.idempotencyKey && view.reads.length) {
        const budget = storage.budget([], [], view.reads);
        if (budget.actions > budget.limit) return yield* Effect.fail(err("BudgetExceeded", "Transactional function exceeds provider action budget"));
        yield* storage.commitAll([], [], view.reads);
      }
      return (result ?? {}) as Wire;
    });
  }

  private context(decl: FunctionDecl, input: unknown, ctx: CallContext, pending: OutboxEntry[], plans: CommitPlan[], delivery?: SubscriptionDelivery, view?: TransactionView, lifecycle?: { active: boolean; busy: boolean }): FunctionContext {
    const engine = this.engine;
    const layer = engine.layer;
    const run = <A>(e: Effect.Effect<A, ForgeError, RuntimeServices>): Effect.Effect<A, ForgeError> => Effect.suspend(() => {
      if (!view) return e.pipe(Effect.provide(layer));
      if (!lifecycle!.active || lifecycle!.busy) return Effect.fail(err("ValidationFailed", "Transactional function calls must be sequential and confined to their body"));
      lifecycle!.busy = true;
      return e.pipe(Effect.provideService(Storage, view.storage), Effect.provide(layer), Effect.ensuring(Effect.sync(() => { lifecycle!.busy = false; })));
    });
    const resources: Record<string, ResourceWriter> = {};
    const transitions: Record<string, Record<string, (id: string, expectedVersion: number, input: Wire) => Effect.Effect<Wire, ForgeError>>> = {};
    const externalIds = new Set<string>();

    // Plan now (validation, version check against current state), commit with the function at the end.
    const mutate = (op: string, body: Wire) =>
      run(
        Effect.gen(function* () {
          if (view) {
            if (plans.length >= 32) return yield* Effect.fail(err("BudgetExceeded", "Transactional functions support at most 32 mutations"));
            const { plan, result } = yield* engine.planAuthorizedCall(op, body, ctx);
            if (!lifecycle!.active) return yield* Effect.fail(err("ValidationFailed", "Function body has completed"));
            yield* view.stage(plan);
            return result;
          }
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
        const call = Effect.gen(function* () {
          if (delivery) yield* delivery.beforeExternal();
          return yield* Effect.tryPromise({ try: () => binding(i, ctx), catch: (e) => err("DependencyUnavailable", String((e as Error).message ?? e)) });
        });
        return view ? run(call) : call;
      },
      send: (channelRef, message, payload) => {
        const ch = engine.model.channel(channelRef);
        if (!ch) return Effect.fail(err("Forbidden", `unknown channel ${channelRef}`));
        if (!allowedSends.has(`${ch.id}#${message}`)) return Effect.fail(err("Forbidden", `${decl.name} may not send ${message} to ${channelRef}; declare it under sends { }`));
        if (ch.direction === "recv-only") return Effect.fail(err("Forbidden", `${channelRef} is recv-only`));
        const stage = () => { pending.push({ tenant: ctx.tenant, opId: "", ordinal: 0, channel: ch.id, message, payload, createdAt: "" }); };
        if (view) return run(Effect.sync(stage));
        stage();
        return Effect.void;
      },
      fail: (name, detail) => {
        if (!decl.errors.includes(name)) return Effect.fail(err("Internal", `${decl.name} raised undeclared error ${name}`));
        return Effect.fail(new ForgeError({ code: `${decl.id}.${name}`, ...(detail ? { detail } : {}) }));
      },
    };
  }

  private commitOutboxOnly(decl: FunctionDecl, ctx: CallContext, outbox: OutboxEntry[], opId: string, at: string, delivery?: SubscriptionDelivery, transaction?: { input: Wire; result: Wire; reads: import("./services.js").ResourceReadGuard[] }): Effect.Effect<void, ForgeError, RuntimeServices> {
    const engine = this.engine;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      // A commit with no record change: adapters treat `kind: "publish"` as outbox + audit only.
      const r = engine.model.resources[0] as Resource;
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at, resource: r, kind: "publish", id: decl.id, expectedVersion: null, before: null, after: {},
        claims: [], references: [], dependents: [], hardDelete: false,
        audit: { tenant: ctx.tenant, opId, resource: decl.id, recordId: decl.id, kind: "function.publish", newVersion: null, actor: ctx.actor, at },
        outbox,
        ...(delivery ? { completion: delivery.completion() } : {}),
        ...(transaction && ctx.idempotencyKey ? { receipt: { tenant: ctx.tenant, operation: decl.id, key: ctx.idempotencyKey, requestHash: yield* Effect.promise(() => sha256(stableJson(transaction.input))), status: 200, response: transaction.result, createdAt: at } } : {}),
      };
      if (transaction) {
        const budget = storage.budget([plan], [], transaction.reads);
        if (budget.actions > budget.limit) return yield* Effect.fail(err("BudgetExceeded", "Transactional function exceeds provider action budget"));
        return yield* storage.commitAll([plan], [], transaction.reads);
      }
      yield* storage.commit(plan);
    });
  }

  /** Subscription consumer: claim, execute, then atomically complete with the handler writes. */
  async consume(subscription: string, env: Envelope): Promise<"processed" | "duplicate" | "unknown-subscription"> {
    const sub = this.engine.model.subscription(subscription);
    if (!sub) return "unknown-subscription";
    const decl = this.engine.model.function(sub.handler);
    if (!decl) return "unknown-subscription";
    const storage = await Effect.runPromise(Effect.service(Storage).pipe(Effect.provide(this.engine.layer)));
    const clock = await Effect.runPromise(Effect.service(Clock).pipe(Effect.provide(this.engine.layer)));
    const requestHash = await sha256(stableJson({ channel: env.channel, message: env.message, payload: env.payload }));
    const delivery = await SubscriptionDelivery.claim(storage, env.tenant, sub.name, env.messageId, requestHash, () => Date.parse(clock.now()));
    if (!delivery) return "duplicate";
    const ctx: CallContext = { tenant: env.tenant, actor: `subscription:${sub.name}`, requestId: env.messageId };
    try {
      await Effect.runPromise(this.invoke(decl, env.payload, ctx, delivery).pipe(Effect.provide(this.engine.layer)));
    } catch (e) {
      await delivery.failed();
      throw e;
    }
    return "processed";
  }
}

export { canonicalize };
