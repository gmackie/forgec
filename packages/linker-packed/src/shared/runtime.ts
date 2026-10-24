// FORG-42: the shared runtime Worker (strategy `per-entry-point-shared`). One Worker per deployment
// holds the engine, every runtime feature and Effect, and no application code and no bindings. A
// packed script calls it over a service binding with Workers RPC and passes a capability object
// (`ScriptCapabilities`, an RpcTarget in the script). Everything the engine touches goes back
// through that object:
//   - storage, blobs, queues, workflows and Durable Objects: the script's own bindings, by name and
//     type, exactly the ones the link injected into that script. The runtime has nothing else to
//     hand out. A binding declared for another script is a refusing stub here, as in host.ts
//     (403 `CapabilityDenied`, FORG-34);
//   - the script's function units and externals: they run in the script, where its bindings are,
//     and reach the engine back through a `RemoteDeps` RpcTarget;
//   - the slice: fetched once per runtime isolate and slice hash, and verified against the hash.
// Parameter stubs are disposed when an RPC call returns (Workers RPC lifecycle), so nothing here may
// use a script's capabilities after the call: post-commit dispatch goes back to the script as a list
// of tenants (the script forwards it to the dispatch owner, as host.ts does), and every other
// `waitUntil` the engine asks for is awaited before the call returns.
import { Effect } from "effect";
import type { AppBundle, ExternalBinding, FunctionContext, FunctionImpl } from "@forgegraph/runtime";
import { cloudflareObjects, createWorkerWith, type WorkerEnv } from "@forgegraph/runtime/cloudflare";
import { capabilityDeniedError, ForgeError } from "@forgegraph/runtime/errors";
import { featuresNamed } from "@forgegraph/runtime/features";
import { serializeError, type DepsShape, type Outcome, type ScriptCapabilities, type SerializedError, type SharedMeta } from "./protocol.ts";

type RpcTargetClass = new () => object;
type EntrypointClass = abstract new (...args: any[]) => any;

const revive = (e: SerializedError) => new ForgeError(e as ConstructorParameters<typeof ForgeError>[0]);

/** A handle whose every method refuses: what the engine holds for a binding withheld from the script. */
function refusing(script: string, b: { type: string; name: string }): unknown {
  const deny = () => {
    throw capabilityDeniedError({ capability: `binding:${b.type}:${b.name}`, entryPoint: script, detail: `${script} is not linked with ${b.type} ${b.name}` });
  };
  return new Proxy({}, { get: (_t, key) => (key === "then" || typeof key === "symbol" ? undefined : deny) });
}

interface Stmt {
  sql: string;
  params: unknown[];
  bind(...values: unknown[]): Stmt;
  first(): Promise<unknown>;
  all(): Promise<unknown>;
  run(): Promise<unknown>;
}

/** The script's bindings as the engine sees them: facades whose every call crosses back to the script. */
function envFor(caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): WorkerEnv {
  const out: Record<string, unknown> = {};
  for (const b of meta.withheld) out[b.name] = refusing(meta.script, b);
  for (const { name, type } of meta.bindings) {
    if (type === "secret" || type === "var") {
      if (name in values) out[name] = values[name];
    } else if (type === "d1") {
      const stmt = (sql: string, params: unknown[]): Stmt => ({
        sql,
        params,
        bind: (...v) => stmt(sql, v),
        first: () => caps.d1(name, "first", sql, params),
        all: () => caps.d1(name, "all", sql, params),
        run: () => caps.d1(name, "run", sql, params),
      });
      out[name] = { prepare: (sql: string) => stmt(sql, []), batch: (ss: Stmt[]) => caps.d1Batch(name, ss.map((s) => ({ sql: s.sql, params: s.params }))) };
    } else if (type === "r2") {
      out[name] = {
        head: (key: string) => caps.r2(name, "head", key),
        get: (key: string) => caps.r2(name, "get", key),
        put: (key: string, value: unknown, options?: unknown) => caps.r2(name, "put", key, value, options),
        delete: (key: string) => caps.r2(name, "delete", key),
      };
    } else if (type === "queue-producer") {
      out[name] = { send: (body: unknown, options?: unknown) => caps.queue(name, body, options) };
    } else if (type === "workflow") {
      out[name] = {
        create: (opts: unknown) => caps.workflow(name, "create", opts),
        get: async (id: string) => ({ sendEvent: (event: unknown) => caps.workflow(name, "sendEvent", { id, event }) }),
      };
    } else if (type === "durable-object") {
      out[name] = {
        idFromName: (n: string) => n,
        get: (id: string) => ({ fetch: (input: Request | string, init?: RequestInit) => caps.durable(name, id, new Request(input, init)) }),
      };
    }
  }
  return out as WorkerEnv;
}

/**
 * Builds the runtime Worker's default entrypoint. `Base` is `WorkerEntrypoint` and `Rpc` is
 * `RpcTarget`, both from `cloudflare:workers` (passed in so this module type-checks and imports
 * outside workerd).
 */
export function sharedRuntime<B extends EntrypointClass>(Base: B, Rpc: RpcTargetClass) {
  /** A function unit's dependencies, reached back from the script while its body runs. */
  class DepsTarget extends Rpc {
    #deps: FunctionContext;
    constructor(deps: FunctionContext) {
      super();
      this.#deps = deps;
    }
    async call(path: string[], args: unknown[]): Promise<Outcome> {
      let target: unknown = this.#deps;
      for (const p of path) target = target && Object.hasOwn(target as object, p) ? (target as Record<string, unknown>)[p] : undefined;
      if (typeof target !== "function" || !["resources", "transitions", "external", "send", "fail"].includes(path[0]!)) return { ok: false, error: { code: "Forbidden", detail: `${path.join(".")} is not a declared dependency` } };
      const effect = (target as (...a: unknown[]) => Effect.Effect<unknown, unknown>)(...args);
      return Effect.runPromise(Effect.match(effect, { onSuccess: (value): Outcome => ({ ok: true, value }), onFailure: (e): Outcome => ({ ok: false, error: serializeError(e) }) }));
    }
  }

  const shapeOf = (deps: FunctionContext): DepsShape => ({ resources: Object.keys(deps.resources), transitions: Object.fromEntries(Object.entries(deps.transitions).map(([r, t]) => [r, Object.keys(t)])) });

  /** Slices by hash, per isolate. A miss fetches the slice from the calling script and checks it against the hash. */
  const slices = new Map<string, AppBundle>();
  async function sliceOf(caps: ScriptCapabilities, meta: SharedMeta): Promise<AppBundle> {
    const hit = slices.get(meta.sliceHash);
    if (hit) return hit;
    const app = (await caps.slice()) as AppBundle;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(app))));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== meta.sliceHash) throw new Error(`forge runtime: ${meta.script} sent a slice that does not match its hash`);
    if (slices.size >= 256) slices.delete(slices.keys().next().value!);
    slices.set(meta.sliceHash, app);
    return app;
  }

  /** The Worker for one call: the slice's model, its features, and units that run in the calling script. */
  function workerFor(app: AppBundle, caps: ScriptCapabilities, meta: SharedMeta, dispatch: string[]) {
    const functions: FunctionImpl[] = meta.functions.map((f) => ({
      id: f.id,
      ...(f.transactional ? { transactional: true } : {}),
      body: (deps: FunctionContext) =>
        Effect.flatMap(
          Effect.promise(() => caps.invoke(f.id, deps.input, deps.ctx, new DepsTarget(deps) as unknown as { call: DepsTarget["call"] }, shapeOf(deps))),
          (r) => (r.ok ? Effect.succeed(r.value as never) : Effect.fail(revive(r.error))),
        ),
    }));
    const externals: Record<string, ExternalBinding> = Object.fromEntries(meta.externals.map((id) => [id, ((input, ctx) => caps.external(id, input, ctx)) as ExternalBinding]));
    return createWorkerWith(app, {
      features: featuresNamed(meta.features),
      ...(meta.objects ? { objects: cloudflareObjects } : {}),
      functions,
      externals,
      sweeps: meta.sweeps,
      // A shared script never sweeps: the dispatch owner does, reached through the script (see above).
      postCommit: async (_env, tenant) => {
        dispatch.push(tenant);
      },
    });
  }

  abstract class ForgeSharedRuntime extends Base {
    async serve(request: Request, caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): Promise<{ response: Response; dispatch: string[] }> {
      const dispatch: string[] = [];
      const waits: Promise<unknown>[] = [];
      const worker = workerFor(await sliceOf(caps, meta), caps, meta, dispatch);
      const response = await worker.fetch(request, envFor(caps, meta, values), { waitUntil: (p) => void waits.push(p) });
      // The response may stream from caller capabilities (blob bytes); buffer it before the stubs go.
      const body = response.body && ![204, 205, 304].includes(response.status) ? await response.arrayBuffer() : null;
      await Promise.allSettled(waits);
      return { response: new Response(body, response), dispatch };
    }

    async queue(queue: string, bodies: unknown[], caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): Promise<Array<"ack" | "retry">> {
      const outcomes: Array<"ack" | "retry"> = bodies.map(() => "retry");
      const worker = workerFor(await sliceOf(caps, meta), caps, meta, []);
      await worker.queue({ queue, messages: bodies.map((body, i) => ({ body, ack: () => void (outcomes[i] = "ack"), retry: () => void (outcomes[i] = "retry") })) }, envFor(caps, meta, values));
      return outcomes;
    }

    async scheduled(event: { cron?: string; scheduledTime?: number }, caps: ScriptCapabilities, meta: SharedMeta, values: Record<string, string>): Promise<void> {
      const waits: Promise<unknown>[] = [];
      const worker = workerFor(await sliceOf(caps, meta), caps, meta, []);
      await worker.scheduled(event, envFor(caps, meta, values), { waitUntil: (p) => void waits.push(p) });
      await Promise.all(waits);
    }
  }
  return ForgeSharedRuntime;
}
