// The thin host every packed script runs (bundled into the script; runs inside workerd).
// It wraps the runtime's Cloudflare host with what the linker decided for the group:
//   - capability injection: the runtime sees only the bindings the manifest declares for the group's
//     entry points (plus host bindings). A binding the manifest declares elsewhere but not here is
//     withheld: the runtime gets a stub that refuses every use with 403 CapabilityDenied (FORG-34),
//     rather than nothing, which would silently fall back (BLOBS to memory, Workflows to the cron);
//   - routing: the script answers only its own entry points' routes and refuses everything else;
//   - dispatch: a sliced script knows only part of the subscription table, so it never sweeps the
//     outbox itself; it hands the nudge to the dispatch owner over a service binding.
import { createRealtimeObject, createWorker, createWorkflowEntrypoint, type WorkerEnv, type WorkerOptions } from "@forgegraph/runtime/cloudflare";
import type { AppBundle } from "@forgegraph/runtime";
import { capabilityDeniedError } from "@forgegraph/runtime/errors";

export interface HostRoute {
  method: string;
  path: string;
}

export interface HostConfig {
  script: string;
  /** Routes this script serves. `null`: every route except `deny` (the residual group). */
  routes: HostRoute[] | null;
  /**
   * Every manifest route on a path this script serves, whatever its method. A request for one of
   * those paths with a method no manifest route has goes to the runtime (405, or a CORS preflight);
   * a method another script serves is refused.
   */
  pathRoutes?: HostRoute[];
  deny: HostRoute[];
  /** Binding names handed to the runtime. Everything else in `env` is withheld. */
  bindings: string[];
  /** Bindings the manifest declares for other scripts: the runtime gets a refusing stub for each. */
  withheld: Array<{ type: string; name: string }>;
  /** `forward`: post-commit work goes to the dispatch owner through the FORGE_DISPATCH service binding. */
  dispatch: "local" | "forward";
  /** Serve the internal dispatch endpoint (the dispatch owner, reached only through service bindings). */
  dispatchOwner: boolean;
  sweeps: { outbox: boolean; schedules: boolean; workflows: boolean };
}

export const DISPATCH_PATH = "/_forge/linker/dispatch";
const DISPATCH_BINDING = "FORGE_DISPATCH";
const FORWARD = Symbol("forge.linker.dispatch");

interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

function matcher(routes: HostRoute[]): (method: string, path: string) => boolean {
  const compiled = routes.map((r) => ({ method: r.method, re: new RegExp(`^${r.path.split("/").map((s) => (/^\{.+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`) }));
  return (method, path) => compiled.some((c) => c.method === method && c.re.test(path));
}

/** A handle whose every method refuses: what the runtime holds for a withheld binding. */
function refusing(script: string, b: { type: string; name: string }): unknown {
  const deny = () => {
    throw capabilityDeniedError({ capability: `binding:${b.type}:${b.name}`, entryPoint: script, detail: `${script} is not linked with ${b.type} ${b.name}` });
  };
  return new Proxy({}, { get: (_t, key) => (key === "then" || typeof key === "symbol" ? undefined : deny) });
}

function narrow(env: Record<string, unknown>, config: HostConfig, forward: Fetcher | undefined): WorkerEnv {
  const out: Record<string, unknown> = {};
  for (const b of config.withheld) out[b.name] = refusing(config.script, b);
  for (const n of config.bindings) if (n in env) out[n] = env[n];
  if (forward) Object.defineProperty(out, FORWARD, { value: forward, enumerable: false });
  return out as WorkerEnv;
}

function refused(script: string, method: string, path: string): Response {
  const body = { type: "about:blank", title: "Not routed", status: 404, code: "NotRouted", detail: `${method} ${path} is not an entry point of ${script}`, retryable: false };
  return new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/problem+json" } });
}

export function packed(app: AppBundle, units: Pick<WorkerOptions, "functions" | "externals">, config: HostConfig) {
  const serves = config.routes ? matcher(config.routes) : () => true;
  const denied = matcher(config.deny);
  const onPath = (path: string) => (config.pathRoutes ?? []).some((r) => matcher([{ ...r, method: "*" }])("*", path));
  const elsewhere = matcher(config.pathRoutes ?? []);
  const forwardTo = (env: WorkerEnv) => (env as unknown as Record<symbol, Fetcher | undefined>)[FORWARD];
  const forward = (env: WorkerEnv, tenant: string, sweep: boolean) => {
    const target = forwardTo(env);
    if (!target) return Promise.reject(new Error(`${config.script}: no ${DISPATCH_BINDING} service binding`));
    return target.fetch(`https://dispatch${DISPATCH_PATH}`, { method: "POST", body: JSON.stringify({ tenant, sweep }), headers: { "content-type": "application/json" } });
  };
  const options: WorkerOptions = {
    ...units,
    sweeps: config.sweeps,
    ...(config.dispatch === "forward" ? { postCommit: (env: WorkerEnv, tenant: string) => forward(env, tenant, true) } : {}),
  };
  const worker = createWorker(app, options);
  const seen = new Set<string>();
  const envFor = (env: Record<string, unknown>) => narrow(env, config, config.dispatch === "forward" ? (env[DISPATCH_BINDING] as Fetcher | undefined) : undefined);

  return {
    worker: {
      async fetch(request: Request, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
        const url = new URL(request.url);
        if (config.dispatchOwner && url.pathname === DISPATCH_PATH && request.method === "POST") {
          const { tenant, sweep } = (await request.json()) as { tenant: string; sweep: boolean };
          await worker.dispatch(envFor(env), tenant, { sweep });
          return new Response(null, { status: 204 });
        }
        const methodMiss = !serves(request.method, url.pathname) && onPath(url.pathname) && !elsewhere(request.method, url.pathname);
        if ((!serves(request.method, url.pathname) && !methodMiss) || denied(request.method, url.pathname)) return refused(config.script, request.method, url.pathname);
        const scoped = envFor(env);
        // The whole-app Worker records every tenant it sees in the schedule index; a slice may hold no
        // schedule, so the dispatch owner records it instead (once per isolate, like the runtime).
        const tenant = request.headers.get("x-forge-tenant");
        if (config.dispatch === "forward" && tenant && !seen.has(tenant)) {
          seen.add(tenant);
          ctx.waitUntil(forward(scoped, tenant, false).catch(() => seen.delete(tenant)));
        }
        return worker.fetch(request, scoped, ctx);
      },
      async scheduled(event: unknown, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void }) {
        return worker.scheduled(event, envFor(env), ctx);
      },
      async queue(batch: Parameters<typeof worker.queue>[0], env: Record<string, unknown>) {
        return worker.queue(batch, envFor(env));
      },
    },
    /** `Base` is `WorkflowEntrypoint` from `cloudflare:workers`. */
    workflow<B extends abstract new (...args: any[]) => any>(Base: B) {
      const Inner = createWorkflowEntrypoint(Base, app, options);
      abstract class PackedWorkflow extends Inner {
        constructor(...args: any[]) {
          super(args[0], envFor(args[1] as Record<string, unknown>));
        }
      }
      return PackedWorkflow;
    },
    /** `Base` is `DurableObject` from `cloudflare:workers`. */
    realtime<B extends abstract new (...args: any[]) => any>(Base: B) {
      const Inner = createRealtimeObject(Base, app, options);
      abstract class PackedRealtime extends Inner {
        constructor(...args: any[]) {
          super(args[0], envFor(args[1] as Record<string, unknown>));
        }
      }
      return PackedRealtime;
    },
  };
}
