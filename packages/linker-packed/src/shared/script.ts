// FORG-42: the host a shared packed script runs (strategy `per-entry-point-shared`). It holds no
// engine: it routes like host.ts, then hands the request to the shared runtime Worker over the
// `FORGE_RUNTIME` service binding, together with a capability object scoped to this script's own
// bindings. Only the bindings the link injected are reachable through it, so the runtime can never
// use more than this script was linked with. Function units and externals run here, where the bindings
// are (`./units.ts`). Post-commit dispatch is forwarded to the dispatch owner exactly as host.ts does.
//
// Imports no runtime code: a script without units bundles only this file, its slice and the entry.
import type { HostConfig, HostRoute } from "../host.ts";
import { RUNTIME_BINDING, type DepsShape, type Outcome, type RemoteDeps, type SharedMeta, type SharedRuntime } from "./protocol.ts";

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

const plain = (r: { results?: unknown[]; meta?: { changes?: number } }) => ({ results: r.results ?? [], meta: { changes: r.meta?.changes ?? 0 } });

export function packedShared(Rpc: RpcTargetClass, app: unknown, units: UnitHost | null, config: HostConfig, linked: Omit<SharedMeta, "functions" | "externals">) {
  const meta: SharedMeta = { ...linked, ...(units?.declared ?? { functions: [], externals: [] }) };
  const types = new Map(meta.bindings.map((b) => [b.name, b.type]));
  /** One binding of this script, by name and the type the link gave it; anything else is refused. */
  const own = <T>(env: Env, name: string, type: string): T => {
    if (types.get(name) !== type || !(name in env)) throw new Error(`${config.script} is not linked with ${type} ${name}`);
    return env[name] as T;
  };

  class Capabilities extends Rpc {
    #env: Env;
    /** Calls the runtime made back into this script during one request (research: `FORGE_RPC_TRACE`). */
    calls = 0;
    constructor(env: Env) {
      super();
      this.#env = env;
    }
    async slice() {
      return app;
    }
    async d1(binding: string, op: "first" | "all" | "run", sql: string, params: unknown[]) {
      const stmt = own<{ prepare(s: string): { bind(...v: unknown[]): { first(): Promise<unknown>; all(): Promise<{ results: unknown[] }>; run(): Promise<{ meta: { changes: number } }> } } }>(this.#env, binding, "d1").prepare(sql).bind(...params);
      if (op === "first") return stmt.first();
      if (op === "all") return { results: (await stmt.all()).results };
      return { meta: { changes: (await stmt.run()).meta.changes } };
    }
    async d1Batch(binding: string, statements: Array<{ sql: string; params: unknown[] }>) {
      const db = own<{ prepare(s: string): { bind(...v: unknown[]): unknown }; batch(s: unknown[]): Promise<Array<{ results?: unknown[]; meta?: { changes?: number } }>> }>(this.#env, binding, "d1");
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
      const ns = own<{ idFromName(n: string): unknown; get(id: unknown): Fetcher }>(this.#env, binding, "durable-object");
      return ns.get(ns.idFromName(name)).fetch(request);
    }
    async invoke(id: string, input: unknown, ctx: unknown, deps: RemoteDeps, shape: DepsShape): Promise<Outcome> {
      if (!units) return { ok: false, error: { code: "Internal", detail: `${config.script} links no unit ${id}` } };
      return units.invoke(id, input, ctx, deps, shape);
    }
    async external(id: string, input: unknown, ctx: unknown) {
      if (!units) throw new Error(`${config.script} links no external ${id}`);
      return units.external(id, input, ctx);
    }
  }

  for (const k of Object.getOwnPropertyNames(Capabilities.prototype).filter((n) => n !== "constructor")) {
    const f = (Capabilities.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!;
    Object.defineProperty(Capabilities.prototype, k, { value: function (this: Capabilities, ...a: unknown[]) { this.calls++; return f.apply(this, a); } });
  }
  /** Research only: with `FORGE_RPC_TRACE` set in the raw env (never a manifest binding), log RPC calls per request. */
  const trace = (env: Env, what: string, caps: Capabilities) => {
    if (env["FORGE_RPC_TRACE"]) console.log(`forge-rpc ${JSON.stringify({ script: config.script, what, callbacks: caps.calls, invocations: 1 })}`);
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
  const forward = (env: Env, tenant: string, sweep: boolean) => {
    const target = env[DISPATCH_BINDING] as Fetcher | undefined;
    if (!target) return Promise.reject(new Error(`${config.script}: no ${DISPATCH_BINDING} service binding`));
    return target.fetch(`https://dispatch${DISPATCH_PATH}`, { method: "POST", body: JSON.stringify({ tenant, sweep }), headers: { "content-type": "application/json" } });
  };
  const seen = new Set<string>();

  return {
    worker: {
      async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
        const url = new URL(request.url);
        const methodMiss = !serves(request.method, url.pathname) && onPath(url.pathname) && !elsewhere(request.method, url.pathname);
        if ((!serves(request.method, url.pathname) && !methodMiss) || denied(request.method, url.pathname)) return refused(config.script, request.method, url.pathname);
        // As host.ts: the dispatch owner records each tenant this isolate sees in the schedule index.
        const tenant = request.headers.get("x-forge-tenant");
        if (tenant && !seen.has(tenant)) {
          seen.add(tenant);
          ctx.waitUntil(forward(env, tenant, false).catch(() => seen.delete(tenant)));
        }
        const caps = new Capabilities(env);
        const { response, dispatch } = await runtime(env).serve(request, caps as never, meta, values(env));
        trace(env, `${request.method} ${url.pathname}`, caps);
        for (const t of dispatch) ctx.waitUntil(forward(env, t, true).catch(() => undefined));
        return response;
      },
      async scheduled(event: { cron?: string; scheduledTime?: number }, env: Env) {
        const caps = new Capabilities(env);
        await runtime(env).scheduled({ ...(event.cron ? { cron: event.cron } : {}), ...(event.scheduledTime ? { scheduledTime: event.scheduledTime } : {}) }, caps as never, meta, values(env));
        trace(env, "scheduled", caps);
      },
      async queue(batch: { queue: string; messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: Env) {
        const caps = new Capabilities(env);
        const outcomes = await runtime(env).queue(batch.queue, batch.messages.map((m) => m.body), caps as never, meta, values(env));
        trace(env, `queue ${batch.queue} (${batch.messages.length})`, caps);
        batch.messages.forEach((m, i) => (outcomes[i] === "ack" ? m.ack() : m.retry()));
      },
    },
  };
}
