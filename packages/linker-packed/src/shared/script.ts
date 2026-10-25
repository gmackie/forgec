// FORG-42: the host a shared packed script runs (strategy `per-entry-point-shared`). It holds no
// engine: it routes like host.ts, then hands the request to the shared runtime Worker over the
// `FORGE_RUNTIME` service binding, together with a capability object scoped to this script's own
// bindings. Only the bindings the link injected are reachable through it, so the runtime can never
// use more than this script was linked with. Function units and externals run here, where the bindings
// are (`./units.ts`). Post-commit dispatch is forwarded to the dispatch owner exactly as host.ts does.
//
// Imports no runtime code: a script without units bundles only this file, its slice and the entry.
import type { HostConfig, HostRoute } from "../host.ts";
import { DEPTH_HEADER, RUNTIME_BINDING, type DepsShape, type Outcome, type RemoteDeps, type SharedMeta, type SharedRuntime } from "./protocol.ts";

export { DEPTH_HEADER };

const DISPATCH_PATH = "/_forge/linker/dispatch";
const DISPATCH_BINDING = "FORGE_DISPATCH";

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
type RpcTargetClass = new () => object;
type Ctx = { waitUntil(p: Promise<unknown>): void };
type Env = Record<string, unknown>;

/** Unit code that runs in this script (`./units.ts`), reached back by the runtime. */
export interface UnitHost {
  /** What the runtime registers in place of the units: ids, and whether a function is transactional (known only from its module). */
  declared: Pick<SharedMeta, "functions" | "externals">;
  invoke(id: string, input: unknown, ctx: unknown, deps: RemoteDeps, shape: DepsShape): Promise<Outcome>;
  external(id: string, input: unknown, ctx: unknown): Promise<unknown>;
}

function matcher(routes: HostRoute[]): (method: string, path: string) => boolean {
  const compiled = routes.map((r) => ({ method: r.method, re: new RegExp(`^${r.path.split("/").map((s) => (/^\{.+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`) }));
  return (method, path) => compiled.some((c) => c.method === method && c.re.test(path));
}

function refused(script: string, method: string, path: string): Response {
  const body = { type: "about:blank", title: "Not routed", status: 404, code: "NotRouted", detail: `${method} ${path} is not an entry point of ${script}`, retryable: false };
  return new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/problem+json" } });
}

/**
 * The deepest Workers stage a shared request may start. Cloudflare refuses a request that nests more
 * than 32 Workers stages ("Subrequest depth limit exceeded"): FORG-38 measured 30 nested hops below a
 * probe (32 stages) working and the 31st failing, deployed on Workers Paid, for RPC and fetch alike
 * (research/composable-units/r4-deployed/, section 5). Sequential calls and callbacks into stubs do not
 * add up there: 1,000 sequential calls and 5,000 stub callbacks passed in one request.
 *
 * So a shared script counts depth, not calls. The router's stage is 1, the script it calls is 2, and
 * every call a script makes starts the stage after its own. The call that would start stage 30 is
 * refused (3 stages in hand, as FORG-42's budget kept 3 calls), and the request fails closed with
 * `RpcBudgetExceeded`. Configurable per link (`LinkOptions.maxDepth`).
 */
export const MAX_DEPTH = 29;

/** A call refused by the depth guard. The name is FORG-42's error code, kept so callers see no change. */
export class DepthExceeded extends Error {
  override readonly name = "RpcBudgetExceeded";
}

/** A request's stage, from the header its caller stamped; a request with none was started by the platform or a client (stage 1). */
export function depthOf(headers: Headers): number {
  const n = Number(headers.get(DEPTH_HEADER));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * The depth of one request, queue batch or cron in a shared script (see MAX_DEPTH). Calls are counted
 * too, for the research trace only: nothing limits them.
 *
 * How depth crosses the hops the shared strategy makes:
 *   - router -> script: the router stamps `x-forge-depth: 2` (overwriting any client value);
 *   - script -> runtime Worker: the script's stage + 1, checked here before the call;
 *   - runtime -> script, the callbacks on `Capabilities`: a callback on a stub runs in the stage of the
 *     Worker that owns the stub (FORG-38: the 40-deep ping-pong through callbacks passed), so it runs at
 *     the script's own stage. The stub holds this guard, so a call made from inside a callback (a
 *     Durable Object fetch, a hand-off) is checked against the script's stage + 1, however the runtime
 *     got there. The runtime Worker has no bindings: it can start no stage but through the stub;
 *   - a unit's `deps` calls back into the engine are callbacks on the runtime's stub: the runtime's
 *     stage, nothing new;
 *   - script -> dispatch owner and script -> Durable Object: the script's stage + 1, stamped in the header.
 */
export class DepthGuard {
  readonly script: string;
  /** This script's own stage. */
  readonly depth: number;
  readonly limit: number;
  /** Cross-script calls made so far (sequential, unlimited: research trace only). */
  calls = 0;
  /** The deepest stage this request started. */
  deepest: number;
  refused: string | null = null;
  /** A D1 batch or run completed before a refusal: a write may have committed. */
  wrote = false;
  constructor(script: string, depth = 1, limit = MAX_DEPTH) {
    this.script = script;
    this.depth = depth;
    this.limit = limit;
    this.deepest = depth;
  }
  /** Checks a call that starts the next stage, and returns that stage. */
  enter(what: string): number {
    const next = this.depth + 1;
    if (next > this.limit) {
      this.refused ??= what;
      throw new DepthExceeded(`${this.script}: ${what} would start Workers stage ${next} of this request; a shared script allows ${this.limit} (Workers refuses a request nested more than 32 stages)`);
    }
    this.calls += 1;
    this.deepest = Math.max(this.deepest, next);
    return next;
  }
  /** A callback into this script, or a unit's call back into the engine: same stage, counted only. */
  count(): void {
    this.calls += 1;
  }
}

/** What a request answers when the guard refused a call: never the runtime's (partial) answer. */
function tooDeep(g: DepthGuard): Response {
  const detail = `${g.script} at Workers stage ${g.depth} refused ${g.refused}: it would start stage ${g.depth + 1}, and a shared script allows ${g.limit} (Workers refuses a request nested more than 32 stages).${g.wrote ? " A write had already committed." : " Nothing was written."}`;
  console.error(`forge: RpcBudgetExceeded ${detail}`);
  const body = { type: "https://forge.dev/errors/rpc-budget-exceeded", title: "RPC budget exceeded", status: 500, code: "RpcBudgetExceeded", detail, retryable: false };
  return new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/problem+json" } });
}

/** The request with `x-forge-depth` stamped (a hop to the next stage). */
function stamped(request: Request, depth: number): Request {
  const headers = new Headers(request.headers);
  headers.set(DEPTH_HEADER, String(depth));
  return new Request(request, { headers });
}

const plain = (r: { results?: unknown[]; meta?: { changes?: number } }) => ({ results: r.results ?? [], meta: { changes: r.meta?.changes ?? 0 } });

/** Link-time options of a shared script (`LinkOptions.maxDepth`). */
export interface SharedOptions {
  /** The deepest Workers stage a request may start (default MAX_DEPTH). */
  maxDepth?: number;
}

export function packedShared(Rpc: RpcTargetClass, app: unknown, units: UnitHost | null, config: HostConfig, linked: Omit<SharedMeta, "functions" | "externals">, options: SharedOptions = {}) {
  const meta: SharedMeta = { ...linked, ...(units?.declared ?? { functions: [], externals: [] }) };
  const limit = options.maxDepth ?? MAX_DEPTH;
  const types = new Map(meta.bindings.map((b) => [b.name, b.type]));
  /** One binding of this script, by name and the type the link gave it; anything else is refused. */
  const own = <T>(env: Env, name: string, type: string): T => {
    if (types.get(name) !== type || !(name in env)) throw new Error(`${config.script} is not linked with ${type} ${name}`);
    return env[name] as T;
  };

  /** Each request's guard, kept off the RpcTarget so the runtime cannot see or change it. */
  const guards = new WeakMap<object, DepthGuard>();
  class Capabilities extends Rpc {
    #env: Env;
    #guard: DepthGuard;
    constructor(env: Env, guard: DepthGuard) {
      super();
      this.#env = env;
      this.#guard = guard;
      guards.set(this, guard);
    }
    async slice() {
      return app;
    }
    async d1(binding: string, op: "first" | "all" | "run", sql: string, params: unknown[]) {
      if (op === "run") this.#guard.wrote = true;
      const stmt = own<{ prepare(s: string): { bind(...v: unknown[]): { first(): Promise<unknown>; all(): Promise<{ results: unknown[] }>; run(): Promise<{ meta: { changes: number } }> } } }>(this.#env, binding, "d1").prepare(sql).bind(...params);
      if (op === "first") return stmt.first();
      if (op === "all") return { results: (await stmt.all()).results };
      return { meta: { changes: (await stmt.run()).meta.changes } };
    }
    async d1Batch(binding: string, statements: Array<{ sql: string; params: unknown[] }>) {
      const db = own<{ prepare(s: string): { bind(...v: unknown[]): unknown }; batch(s: unknown[]): Promise<Array<{ results?: unknown[]; meta?: { changes?: number } }>> }>(this.#env, binding, "d1");
      this.#guard.wrote = true;
      return (await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)))).map(plain);
    }
    async r2(binding: string, op: "head" | "get" | "put" | "delete", key: string, value?: unknown, options?: unknown) {
      const bucket = own<Record<string, (...a: unknown[]) => Promise<any>>>(this.#env, binding, "r2");
      if (op === "delete") return void (await bucket["delete"]!(key));
      // R2 needs a stream of known length, and a stream that crossed RPC has none: buffer it (bounded by
      // the blob's declared byteCount, and the isolate's 128 MB). A shared script cannot stream an upload.
      if (op === "put") return { etag: (await bucket["put"]!(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options)).etag as string };
      const o = await bucket[op]!(key);
      if (!o) return null;
      const meta = { size: o.size as number, etag: o.etag as string, httpMetadata: o.httpMetadata?.contentType ? { contentType: o.httpMetadata.contentType as string } : {} };
      return op === "get" ? { ...meta, body: o.body } : meta;
    }
    async queue(binding: string, body: unknown, options?: unknown) {
      await own<{ send(b: unknown, o?: unknown): Promise<void> }>(this.#env, binding, "queue-producer").send(body, options);
    }
    async workflow(binding: string, op: "create" | "sendEvent", arg: unknown) {
      const wf = own<{ create(o: unknown): Promise<unknown>; get(id: string): Promise<{ sendEvent(e: unknown): Promise<void> }> }>(this.#env, binding, "workflow");
      if (op === "create") return void (await wf.create(arg));
      const { id, event } = arg as { id: string; event: unknown };
      await (await wf.get(id)).sendEvent(event);
    }
    async durable(binding: string, name: string, request: Request) {
      // The object is a Worker stage of its own, one below this script's (the callback runs at this script's stage).
      const next = this.#guard.enter(`a Durable Object fetch on ${binding}`);
      const ns = own<{ idFromName(n: string): unknown; get(id: unknown): Fetcher }>(this.#env, binding, "durable-object");
      return ns.get(ns.idFromName(name)).fetch(stamped(request, next));
    }
    async invoke(id: string, input: unknown, ctx: unknown, deps: RemoteDeps, shape: DepsShape): Promise<Outcome> {
      if (!units) return { ok: false, error: { code: "Internal", detail: `${config.script} links no unit ${id}` } };
      // A unit's calls back into the engine are callbacks on the runtime's stub: its stage, nothing deeper.
      const guard = this.#guard;
      const counted: RemoteDeps = {
        call: (path, args) => {
          guard.count();
          return deps.call(path, args);
        },
      };
      return units.invoke(id, input, ctx, counted, shape);
    }
    async external(id: string, input: unknown, ctx: unknown) {
      if (!units) throw new Error(`${config.script} links no external ${id}`);
      return units.external(id, input, ctx);
    }
  }

  // Every callback the runtime makes into this script is counted (for the trace), never limited.
  for (const k of Object.getOwnPropertyNames(Capabilities.prototype).filter((n) => n !== "constructor")) {
    const f = (Capabilities.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!;
    Object.defineProperty(Capabilities.prototype, k, {
      value: function (this: Capabilities, ...a: unknown[]) {
        guards.get(this)!.count();
        return f.apply(this, a);
      },
    });
  }
  /** Research only: with `FORGE_RPC_TRACE` set in the raw env (never a manifest binding), log each request's depth and calls. */
  const trace = (env: Env, what: string, g: DepthGuard) => {
    if (env["FORGE_RPC_TRACE"]) console.log(`forge-rpc ${JSON.stringify({ script: config.script, what, depth: g.depth, deepest: g.deepest, calls: g.calls, refused: g.refused })}`);
  };
  /** Calls the runtime and reports a refusal as itself, whatever the runtime made of it. */
  const guarded = async <T>(g: DepthGuard, call: () => Promise<T>): Promise<T> => {
    if (g.depth > g.limit) {
      g.refused ??= `a request arriving at stage ${g.depth}`;
      throw new DepthExceeded(`${g.script}: arrived at Workers stage ${g.depth}, deeper than ${g.limit}`);
    }
    g.enter("the call to the runtime Worker");
    try {
      const out = await call();
      if (g.refused) throw new DepthExceeded(`${g.script}: refused ${g.refused}`);
      return out;
    } catch (e) {
      if (g.refused) throw new DepthExceeded(`${g.script}: refused ${g.refused} at stage ${g.depth + 1} (limit ${g.limit})`);
      throw e;
    }
  };
  const values = (env: Env) => Object.fromEntries(meta.bindings.filter((b) => (b.type === "secret" || b.type === "var") && typeof env[b.name] === "string").map((b) => [b.name, env[b.name] as string]));
  const runtime = (env: Env) => {
    const r = env[RUNTIME_BINDING] as SharedRuntime | undefined;
    if (!r) throw new Error(`${config.script}: no ${RUNTIME_BINDING} service binding`);
    return r;
  };
  const serves = config.routes ? matcher(config.routes) : () => true;
  const denied = matcher(config.deny);
  const onPath = (path: string) => (config.pathRoutes ?? []).some((r) => matcher([{ ...r, method: "*" }])("*", path));
  const elsewhere = matcher(config.pathRoutes ?? []);
  /** A hand-off to the dispatch owner: the next stage, so checked and stamped. A refusal leaves the work to the cron sweep. */
  const forward = (env: Env, g: DepthGuard, tenant: string, sweep: boolean) => {
    const target = env[DISPATCH_BINDING] as Fetcher | undefined;
    if (!target) return Promise.reject(new Error(`${config.script}: no ${DISPATCH_BINDING} service binding`));
    let next: number;
    try {
      next = g.enter(sweep ? "the post-commit hand-off" : "the schedule-index hand-off");
    } catch (e) {
      console.error(`forge: ${(e as Error).message}; left to the cron sweep`);
      return Promise.reject(e);
    }
    return target.fetch(`https://dispatch${DISPATCH_PATH}`, { method: "POST", body: JSON.stringify({ tenant, sweep }), headers: { "content-type": "application/json", [DEPTH_HEADER]: String(next) } });
  };
  const seen = new Set<string>();

  return {
    worker: {
      async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
        const url = new URL(request.url);
        const methodMiss = !serves(request.method, url.pathname) && onPath(url.pathname) && !elsewhere(request.method, url.pathname);
        if ((!serves(request.method, url.pathname) && !methodMiss) || denied(request.method, url.pathname)) return refused(config.script, request.method, url.pathname);
        const guard = new DepthGuard(config.script, depthOf(request.headers), limit);
        // The depth is the linker's, not the app's: the engine sees the request the router was sent.
        if (request.headers.has(DEPTH_HEADER)) {
          const headers = new Headers(request.headers);
          headers.delete(DEPTH_HEADER);
          request = new Request(request, { headers });
        }
        // As host.ts: the dispatch owner records each tenant this isolate sees in the schedule index.
        const tenant = request.headers.get("x-forge-tenant");
        if (tenant && !seen.has(tenant)) {
          seen.add(tenant);
          ctx.waitUntil(forward(env, guard, tenant, false).catch(() => seen.delete(tenant)));
        }
        let result: { response: Response; dispatch: string[] };
        try {
          const caps = new Capabilities(env, guard);
          result = await guarded(guard, () => runtime(env).serve(request, caps as never, meta, values(env)));
        } catch (e) {
          trace(env, `${request.method} ${url.pathname}`, guard);
          if (e instanceof DepthExceeded) return tooDeep(guard);
          throw e;
        }
        // One hand-off per committed tenant: sequential calls, so no limit.
        for (const t of result.dispatch) ctx.waitUntil(forward(env, guard, t, true).catch(() => undefined));
        trace(env, `${request.method} ${url.pathname}`, guard);
        return result.response;
      },
      async scheduled(event: { cron?: string; scheduledTime?: number }, env: Env) {
        const guard = new DepthGuard(config.script, 1, limit);
        try {
          const caps = new Capabilities(env, guard);
          await guarded(guard, () => runtime(env).scheduled({ ...(event.cron ? { cron: event.cron } : {}), ...(event.scheduledTime ? { scheduledTime: event.scheduledTime } : {}) }, caps as never, meta, values(env)));
        } finally {
          trace(env, "scheduled", guard);
        }
      },
      async queue(batch: { queue: string; messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: Env) {
        const guard = new DepthGuard(config.script, 1, limit);
        let outcomes: Array<"ack" | "retry">;
        try {
          // Refused, the batch throws: every message is retried, and the refusal is in the error.
          const caps = new Capabilities(env, guard);
          outcomes = await guarded(guard, () => runtime(env).queue(batch.queue, batch.messages.map((m) => m.body), caps as never, meta, values(env)));
        } finally {
          trace(env, `queue ${batch.queue} (${batch.messages.length})`, guard);
        }
        batch.messages.forEach((m, i) => (outcomes[i] === "ack" ? m.ack() : m.retry()));
      },
    },
  };
}
