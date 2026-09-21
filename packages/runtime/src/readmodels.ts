/**
 * Views (§17), projections (§17) and caches (§16). All three are built on the
 * primitives every adapter already provides: bounded list queries and opaque
 * documents with optimistic versions, so no adapter grows a new storage shape.
 */
import { Cause, Effect } from "effect";
import { formatMinor, toMinor } from "./codecs.js";
import type { Wire } from "./decode.js";
import { canonicalize, evalExpr } from "./decode.js";
import type { Envelope, Transport } from "./dispatch.js";
import type { CallContext, Engine } from "./engine.js";
import { err, ForgeError } from "./errors.js";
import type { CacheDecl, Expr, ProjectionDecl, ViewDecl } from "./model.js";
import { Clock, Storage, type RuntimeServices } from "./services.js";

const PROJ = "projection";
const CACHE = "cache";
/** Composite group key separator (never appears in identifiers). */
const SEP = String.fromCharCode(1);

type Doc = Record<string, unknown> & { _version?: number };
interface ProjectionMeta extends Doc { generation: number; status: "active" | "building"; builtAt: string; lastProcessed: unknown }
interface Contribution extends Doc { version: number; key?: string; values?: Record<string, string> }
interface CacheEntry extends Doc { value: Wire; freshUntil: string; loadedAt: string }

/**
 * Route `projection:*` subscriptions to the in-process projection applier and everything
 * else to the host's queue transport, so projections ride the same durable outbox.
 */
export function withProjections(engine: Engine, fallback: Transport): Transport {
  const local = engine.projectionTransport();
  const workflows = engine.workflows.transport();
  const realtime = engine.realtime.transport();
  return {
    name: `${fallback.name}+internal`,
    send: (d) => (d.subscription.startsWith("projection:") ? local.send(d) : d.subscription.startsWith("workflow:") ? workflows.send(d) : d.subscription.startsWith("realtime:") ? realtime.send(d) : fallback.send(d)),
  };
}
/** Every in-process consumer's subscriptions (projections and workflow waits) merged over the host's. */
export function internalSubscriptions(engine: Engine, base: Record<string, string[]> = {}): Record<string, string[]> {
  return engine.realtime.subscriptions(engine.workflows.subscriptions(engine.projectionSubscriptions(base)));
}

export class ReadModels {
  constructor(private readonly engine: Engine) {}

  // ------------------------------------------------------------------ views
  /** Lower the view onto the source's bounded list for its `by` fields, then filter and project fields. */
  view(v: ViewDecl, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const r = self.engine.model.resource(v.source);
      const params = (body["params"] ?? {}) as Wire;
      const missing = v.by.filter((f) => params[f] === undefined || params[f] === null);
      if (missing.length) {
        return yield* Effect.fail(err("ValidationFailed", "view partition parameters are required", { fields: missing.map((f) => ({ path: `params.${f}`, code: "Required", message: `${v.name} is partitioned by ${f}` })) }));
      }
      const list = r.lists.find((l) => l.fields.join(",") === v.by.join(","));
      if (!list) return yield* Effect.fail(err("Internal", `view ${v.name} has no bounded access path on ${r.name}`));
      const limit = Math.min(Math.max(Number(body["limit"] ?? 50), 1), 100);
      // Walk the bounded working set page by page so the filter never shrinks a page below `limit` while rows remain.
      const items: Wire[] = [];
      let cursor: unknown = body["cursor"] ?? null;
      let next: unknown = null;
      for (let pages = 0; pages < 100; pages++) {
        const page = yield* self.engine.callInternal(`${r.id}.list.${list.name}`, { params: Object.fromEntries(v.by.map((f) => [f, params[f]])), limit: 100, ...(cursor ? { cursor } : {}) }, ctx);
        for (const rec of page.items as Wire[]) {
          if (v.where && !evalExpr(self.engine.model, r, v.where, rec)) continue;
          items.push(Object.fromEntries(v.fields.map((f) => [f, rec[f] ?? null])));
          if (items.length === limit) break;
        }
        next = page.next ?? null;
        if (items.length === limit || !next) break;
        cursor = next;
      }
      return { items, next: items.length === limit ? next : null, limit };
    });
  }

  // ------------------------------------------------------------ projections
  private groupKey(p: ProjectionDecl, rec: Wire): string {
    return p.by.map((f) => String(rec[f])).join(SEP);
  }
  private contributes(p: ProjectionDecl, rec: Wire): boolean {
    return p.where ? Boolean(evalExpr(this.engine.model, this.engine.model.resource(p.source), p.where, rec)) : true;
  }
  /** Exact contribution of one record: counts as "1", sums as minor-unit integers. */
  private contribution(p: ProjectionDecl, rec: Wire): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of p.aggregates) {
      out[a.alias] = a.function === "count" ? "1" : a.scale !== undefined ? toMinor(String(rec[a.field] ?? "0"), a.scale).toString() : String(Math.trunc(Number(rec[a.field] ?? 0)));
    }
    return out;
  }
  private meta(p: ProjectionDecl, tenant: string) {
    return Effect.gen(function* () {
      return (yield* (yield* Storage).getDocument(tenant, PROJ, `${p.name}:meta`)) as ProjectionMeta | null;
    });
  }
  private render(p: ProjectionDecl, key: string, doc: Doc | null, generation: number): Wire {
    const out: Wire = {};
    const parts = key.split(SEP);
    p.by.forEach((f, i) => (out[f] = parts[i] ?? null));
    for (const a of p.aggregates) {
      const raw = BigInt(String(doc?.[a.alias] ?? "0"));
      out[a.alias] = a.function === "count" || a.scale === undefined ? Number(raw) : formatMinor(raw, a.scale);
    }
    out["generation"] = generation;
    return out;
  }

  status(p: ProjectionDecl, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const m = yield* self.meta(p, ctx.tenant);
      if (!m) return { generation: 0, status: "not-built", lastProcessed: null };
      const { _version, ...rest } = m;
      void _version;
      return rest;
    });
  }

  get(p: ProjectionDecl, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const m = yield* self.meta(p, ctx.tenant);
      if (!m || m.status !== "active") return yield* Effect.fail(err("ProjectionNotReady", `${p.name} has no active generation; run rebuild`));
      const key = String(body["id"] ?? "");
      const doc = yield* (yield* Storage).getDocument(ctx.tenant, PROJ, `${p.name}:${m.generation}:group:${key}`);
      return self.render(p, key, doc, m.generation);
    });
  }

  /**
   * Apply one source change event. The contribution ledger is keyed by source id
   * and carries the record revision, so replays and out-of-order deliveries are
   * ignored and a moved or filtered-out record is subtracted before being re-added.
   */
  applyEvent(p: ProjectionDecl, env: Envelope): Effect.Effect<"applied" | "stale" | "ignored", ForgeError, RuntimeServices> {
    const self = this;
    // Concurrent sweeps may apply different events to one group: the loser of a CAS reloads and retries
    // (the ledger makes the retry idempotent) instead of leaving the row to a lease timeout.
    return Effect.gen(function* () {
      for (let attempt = 0; ; attempt++) {
        const exit = yield* Effect.exit(self.applyEventOnce(p, env));
        if (exit._tag === "Success") return exit.value;
        const e = Cause.squash(exit.cause);
        if (e instanceof ForgeError && (e.code === "VersionConflict" || e.code === "TransientConflict") && attempt < 8) continue;
        return yield* Effect.fail(e instanceof ForgeError ? e : err("Internal", String(e)));
      }
    });
  }

  private applyEventOnce(p: ProjectionDecl, env: Envelope): Effect.Effect<"applied" | "stale" | "ignored", ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const tenant = env.tenant;
      const m = yield* self.meta(p, tenant);
      if (!m || m.status !== "active") return "ignored" as const;
      const storage = yield* Storage;
      const r = self.engine.model.resource(p.source);
      const id = String(env.payload?.id ?? "");
      const version = Number(env.payload?.version ?? 0);
      const ledgerId = `${p.name}:${m.generation}:contrib:${id}`;
      const ledger = (yield* storage.getDocument(tenant, PROJ, ledgerId)) as Contribution | null;
      if (ledger && ledger.version >= version) return "stale" as const;
      const stored = yield* storage.get(tenant, r, id);
      const canon = stored && !stored["deletedAt"] ? canonicalize(self.engine.model, r, stored) : null;
      const live = canon !== null && self.contributes(p, canon);
      const newKey = live ? self.groupKey(p, canon) : undefined;
      const newValues = live ? self.contribution(p, canon) : undefined;
      const adjust = (key: string, values: Record<string, string>, sign: 1n | -1n) =>
        Effect.gen(function* () {
          const gid = `${p.name}:${m.generation}:group:${key}`;
          const doc = (yield* storage.getDocument(tenant, PROJ, gid)) as Doc | null;
          const next: Doc = {};
          for (const a of p.aggregates) next[a.alias] = (BigInt(String(doc?.[a.alias] ?? "0")) + sign * BigInt(values[a.alias] ?? "0")).toString();
          yield* storage.putDocument(tenant, PROJ, gid, next, doc?._version ?? null);
        });
      if (ledger?.key && ledger.values) yield* adjust(ledger.key, ledger.values, -1n);
      if (newKey !== undefined && newValues) yield* adjust(newKey, newValues, 1n);
      const entry: Contribution = { version: Math.max(version, canon ? Number(canon["version"] ?? 0) : 0) };
      if (newKey !== undefined && newValues) Object.assign(entry, { key: newKey, values: newValues });
      yield* storage.putDocument(tenant, PROJ, ledgerId, entry, ledger?._version ?? null);
      const { _version, ...meta } = m;
      yield* storage.putDocument(tenant, PROJ, `${p.name}:meta`, { ...meta, lastProcessed: { messageId: env.messageId, at: env.createdAt } }, _version ?? null);
      return "applied" as const;
    });
  }

  /** Rebuild into a fresh generation from the source's bounded default list, then switch the active pointer. */
  rebuild(p: ProjectionDecl, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const r = self.engine.model.resource(p.source);
      const prev = yield* self.meta(p, ctx.tenant);
      const generation = (prev?.generation ?? 0) + 1;
      const groups = new Map<string, Record<string, bigint>>();
      let cursor: unknown = null;
      for (let pages = 0; pages < 10_000; pages++) {
        const page = yield* self.engine.callInternal(`${r.id}.list.all`, { params: {}, limit: 100, ...(cursor ? { cursor } : {}) }, ctx);
        for (const rec of page.items as Wire[]) {
          if (!self.contributes(p, rec)) continue;
          const key = self.groupKey(p, rec);
          const values = self.contribution(p, rec);
          const g = groups.get(key) ?? {};
          for (const a of p.aggregates) g[a.alias] = (g[a.alias] ?? 0n) + BigInt(values[a.alias]!);
          groups.set(key, g);
          const entry: Contribution = { version: Number(rec["version"] ?? 0), key, values };
          yield* storage.putDocument(ctx.tenant, PROJ, `${p.name}:${generation}:contrib:${rec["id"]}`, entry, null);
        }
        cursor = page.next ?? null;
        if (!cursor) break;
      }
      for (const [key, g] of groups) {
        yield* storage.putDocument(ctx.tenant, PROJ, `${p.name}:${generation}:group:${key}`, Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.toString()])), null);
      }
      const meta: Omit<ProjectionMeta, "_version"> = { generation, status: "active", builtAt: (yield* Clock).now(), lastProcessed: null };
      yield* storage.putDocument(ctx.tenant, PROJ, `${p.name}:meta`, meta, prev?._version ?? null);
      return meta;
    });
  }

  // ------------------------------------------------------------------ cache
  /** In-process single-flight: concurrent misses for one key share a loader run (a local optimisation, not a global lock). */
  private readonly inflight = new Map<string, Promise<Wire>>();

  read(c: CacheDecl, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const key = (body["key"] ?? {}) as Wire;
      const missing = c.keys.filter((k) => key[k.name] === undefined || key[k.name] === null);
      if (missing.length) {
        return yield* Effect.fail(err("ValidationFailed", "every input that affects the cached value is part of its key", { fields: missing.map((k) => ({ path: `key.${k.name}`, code: "Required", message: `${c.name} is keyed by ${k.name}` })) }));
      }
      const storage = yield* Storage;
      const now = (yield* Clock).now();
      const docId = `${c.name}:${c.keys.map((k) => String(key[k.name])).join(SEP)}`;
      const cached = (yield* storage.getDocument(ctx.tenant, CACHE, docId)) as CacheEntry | null;
      // Expired entries are rejected on read regardless of physical cleanup (§16).
      if (cached && cached.freshUntil > now) return { value: cached.value, source: "cache", freshUntil: cached.freshUntil };
      const flightKey = `${ctx.tenant}|${docId}`;
      const existing = self.inflight.get(flightKey);
      if (existing) {
        const v = yield* Effect.promise(() => existing);
        return { ...v, source: "cache" };
      }
      const flight = Effect.runPromise(self.load(c, key, ctx, now, docId, cached?._version ?? null).pipe(Effect.provide(self.engine.layer)));
      self.inflight.set(flightKey, flight);
      return yield* Effect.tryPromise({ try: () => flight, catch: (e) => (e instanceof Error && "code" in e ? (e as unknown as ForgeError) : err("Internal", String(e))) }).pipe(Effect.ensuring(Effect.sync(() => self.inflight.delete(flightKey))));
    });
  }

  private load(c: CacheDecl, key: Wire, ctx: CallContext, now: string, docId: string, docVersion: number | null): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const { value, nextBoundary } = yield* self.runLoader(c, key, ctx, now);
      const freshUntil = self.freshness(c.freshUntil, now, nextBoundary);
      const entry: Omit<CacheEntry, "_version"> = { value, freshUntil, loadedAt: now };
      // A concurrent writer stored an equally fresh value: losing that race is harmless.
      yield* (yield* Storage).putDocument(ctx.tenant, CACHE, docId, entry, docVersion).pipe(Effect.catch(() => Effect.void));
      return { value, source: "loader", freshUntil };
    });
  }

  /** Loader `Resource.effective(key..., now)` lowers to the resource's effective query and yields the next boundary. */
  private runLoader(c: CacheDecl, key: Wire, ctx: CallContext, now: string): Effect.Effect<{ value: Wire; nextBoundary: string | null }, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const loader = c.loader;
      if (loader.kind !== "call" || loader.callee.length !== 2 || loader.callee[1] !== "effective") {
        return yield* Effect.fail(err("Internal", `cache ${c.name}: only <Resource>.effective(...) loaders are supported`));
      }
      const r = self.engine.model.resources.find((x) => x.name === loader.callee[0]);
      const ed = r?.decorators.effectiveDated;
      if (!r || !ed) return yield* Effect.fail(err("Internal", `cache ${c.name}: ${loader.callee[0]} is not effective-dated`));
      const params: Wire = { at: now };
      ed.uniqueBy.forEach((f, i) => {
        const arg = loader.args[i];
        params[f] = arg && arg.kind === "name" ? key[arg.path[0]!] : key[f];
      });
      const query = `by${ed.uniqueBy.map((f) => f[0]!.toUpperCase() + f.slice(1)).join("")}`;
      const value = (yield* self.engine.callInternal(`${r.id}.effective.${query}`, { params }, ctx)) as Wire;
      return { value, nextBoundary: (value["effectiveUntil"] as string | null | undefined) ?? null };
    });
  }

  /** `freshUntil` is a duration, `nextEffectiveBoundary`, or `min(...)` of those; an unknown boundary contributes nothing. */
  private freshness(e: Expr, now: string, nextBoundary: string | null): string {
    const nowMs = Date.parse(now);
    const at = (x: Expr): number | null => {
      if (x.kind === "literal" && x.literal.type === "duration") return nowMs + durationMs(x.literal.value);
      if (x.kind === "name" && x.path[0] === "nextEffectiveBoundary") return nextBoundary ? Date.parse(nextBoundary) : null;
      if (x.kind === "call" && x.callee[0] === "min") {
        const vals = x.args.map(at).filter((v): v is number => v !== null);
        return vals.length ? Math.min(...vals) : null;
      }
      return null;
    };
    return new Date(at(e) ?? nowMs).toISOString();
  }
}

export function durationMs(d: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(d);
  if (!m) return 0;
  const n = Number(m[1]);
  return { ms: n, s: n * 1_000, m: n * 60_000, h: n * 3_600_000, d: n * 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
}
