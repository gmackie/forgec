// Linker C's dynamic tier (bundled into the tier host script; runs inside workerd). It is linker B's
// host (`@forgegraph/linker-dynamic/host`) with three additions:
//   - the Workflows class of every dynamic workflow, whose driver steps run in B's child and fall back
//     to the packed script holding the workflow (linker A's advance endpoint) when the child cannot load;
//   - a guard on `PUT /_linker/manifest`: a dynamic swap may not need a binding this script was not
//     deployed with (the child would get no handle, and the runtime would quietly do without);
//   - `GET /_linker/tier`: the tier's configuration and its workflow fallbacks (admin token).
// Requests reach it only from linker C's router, which falls back to the packed script whenever the
// answer carries B's refusal header (REFUSED_HEADER): a refusal made before any unit code ran.
// Because this script binds FORGE_DISPATCH, B hands every post-commit dispatch to linker A's dispatch
// owner and probes each child before use (packages/linker-dynamic/src/host.ts).
import { LinkError } from "@forgegraph/linker-dynamic";
import dynamic, { advanceWorkflow, type HostEnv } from "@forgegraph/linker-dynamic/host";

export interface TierConfig {
  script: string;
  manifestHash: string;
  /** Entry point ids the router sends here. */
  dynamic: string[];
  /** Env binding names this script is deployed with (what a swapped manifest's dynamic closures may use). */
  bindings: string[];
  workflows: Array<{ className: string; entryPoint: string; /** Service binding to the packed script holding the class. */ packed: string; packedScript: string }>;
  advancePath: string;
}

interface Exports {
  exports: Record<string, (o: { props: unknown }) => unknown>;
  waitUntil(p: Promise<unknown>): void;
}
interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}
type StepLike = { do<T>(name: string, fn: () => Promise<T>): Promise<T>; sleep(name: string, ms: number): Promise<void>; waitForEvent(name: string, opts: { type: string; timeout?: string | number }): Promise<unknown> };
type State = { status: string; dueAt?: string };

/** Bindings an entry point's closure is handed by the dynamic host (B's policy). */
const HANDLE_TYPES = new Set(["d1", "r2", "queue-producer", "workflow"]);

export function tier(config: TierConfig) {
  const stats = { workflowAdvances: { dynamic: 0, fallback: 0 }, fallbacks: [] as Array<{ at: string; className: string; reason: string; detail: string }> };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const dynamicSet = new Set(config.dynamic);

  /** A dynamic swap may change implementations, not the bindings this script holds. */
  function missingBindings(text: string, env: HostEnv): string[] {
    let m: { entryPoints?: Array<{ id: string; bindings?: Array<{ type: string; name: string }> }> };
    try {
      m = JSON.parse(text);
    } catch {
      return []; // B refuses it with its own problem
    }
    const missing = new Set<string>();
    for (const e of m.entryPoints ?? []) {
      if (!dynamicSet.has(e.id)) continue;
      for (const b of e.bindings ?? []) if (HANDLE_TYPES.has(b.type) && !(b.name in env)) missing.add(`${e.id}: ${b.type} ${b.name}`);
    }
    return [...missing].sort();
  }

  return {
    worker: {
      async fetch(request: Request, env: HostEnv, ctx: Exports): Promise<Response> {
        const url = new URL(request.url);
        const admin = !!env.LINKER_ADMIN_TOKEN && request.headers.get("x-linker-admin") === env.LINKER_ADMIN_TOKEN;
        if (url.pathname === "/_linker/tier" && request.method === "GET") return admin ? json({ config, stats }) : json({ code: "Forbidden" }, 403);
        if (url.pathname === "/_linker/manifest" && request.method === "PUT" && admin) {
          const text = await request.text();
          const missing = missingBindings(text, env);
          if (missing.length) {
            const detail = `the dynamic tier ${config.script} is not deployed with ${missing.join("; ")}: re-link linker C to move these bindings`;
            return new Response(JSON.stringify({ type: "https://forge.dev/errors/linker/TierBindingMissing", title: "TierBindingMissing", status: 409, code: "TierBindingMissing", detail, problems: missing }), { status: 409, headers: { "content-type": "application/problem+json" } });
          }
          return dynamic.fetch(new Request(request, { body: text }), env, ctx);
        }
        return dynamic.fetch(request, env, ctx);
      },
    },

    /** The Workflows class for a dynamic workflow (`Base` is `WorkflowEntrypoint` from `cloudflare:workers`). */
    workflow<B extends abstract new (...args: any[]) => any>(Base: B, className: string) {
      const found = config.workflows.find((w) => w.className === className);
      if (!found) throw new Error(`linker-tiered: ${className} is not a dynamic workflow of ${config.script}`);
      const wf = found;
      abstract class TieredWorkflow extends Base {
        async run(event: { payload: { tenant: string; id: string } }, step: StepLike) {
          const self = this as unknown as { env: HostEnv; ctx: Exports };
          const { tenant, id } = event.payload;
          const advance = async (): Promise<State> => {
            try {
              const st = await advanceWorkflow(self.env, self.ctx, className, tenant, id);
              stats.workflowAdvances.dynamic++;
              return st;
            } catch (e) {
              // A LinkError is raised before the child runs any unit code: replaying the step packed is safe.
              if (!(e instanceof LinkError)) throw e;
              stats.workflowAdvances.fallback++;
              stats.fallbacks.push({ at: new Date().toISOString(), className, reason: e.code, detail: e.message.slice(0, 300) });
              if (stats.fallbacks.length > 50) stats.fallbacks.shift();
              console.warn(`linker-tiered: FALLBACK workflow ${wf.entryPoint} (${tenant}/${id}) -> packed ${wf.packedScript}: ${e.code}`);
              const packed = (self.env as Record<string, unknown>)[wf.packed] as Fetcher | undefined;
              if (!packed) throw new Error(`linker-tiered: no ${wf.packed} service binding`);
              const r = await packed.fetch(`https://packed${config.advancePath}`, { method: "POST", body: JSON.stringify({ tenant, id }), headers: { "content-type": "application/json" } });
              if (!r.ok) throw new Error(`linker-tiered: packed advance answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
              return (await r.json()) as State;
            }
          };
          // The runtime's driver loop (createWorkflowEntrypointWith), with the tiered step.
          for (let n = 0; n < 10_000; n++) {
            const state = await step.do(`advance:${n}`, advance);
            if (state.status === "sleeping") await step.sleep(`sleep:${n}`, Math.max(0, Date.parse(state.dueAt!) - Date.now()));
            else if (state.status === "waiting") {
              const timeout = state.dueAt ? Math.max(1000, Date.parse(state.dueAt) - Date.now()) : 365 * 24 * 3600 * 1000;
              try {
                await step.waitForEvent(`wait:${n}`, { type: "forge.wake", timeout });
              } catch {
                // Deadline reached: the next advance applies the timeout.
              }
            } else if (state.status === "running") await step.sleep(`retry:${n}`, 1000);
            else return state;
          }
          return null;
        }
      }
      return TieredWorkflow;
    },
  };
}
