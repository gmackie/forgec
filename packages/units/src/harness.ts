// Stands in for a linker (FORG-31): turns one unit of a sealed manifest into the Worker modules
// that run it behind a fixed caller. The caller module is the same bytes whatever the unit's
// kind; only `bound.js`, which the linker generates, differs:
//
//   js-module       the sealed module bundled with its shared libraries, run through Effect
//   wasm-component  the component transpiled to core module(s) + jco glue, instantiated from
//                   precompiled module imports and adapted to wire values by its lowering
//
// Both export `invoke(input): Promise<UnitResult>` and `ready()`.
//
// Capability handles (FORG-36) come from a third module, `host.js`, which stands in for the
// runtime's resource store, transition units, callees and outbox. It exports
// `capability(name)`: the handle for one declared capability (`resource:<id>#read`, ...), whose
// functions take and answer wire values (`CapabilityHandle`), or null. Both kinds bind the same
// handles: the js-module through its FunctionContext, the wasm-component through its WIT imports
// (JSPI). A declared capability the host does not provide fails closed on the first call.
import { build, type Plugin } from "esbuild";
import { join } from "node:path";
import type { Sealed } from "./seal.ts";
import { transpileComponent, type TranspileOptions, type Transpiled } from "./wasm.ts";
import { asyncImports, type Lowering } from "./wit-lowering.ts";

export interface WorkerModule {
  type: "ESModule" | "CompiledWasm";
  path: string;
  contents: Uint8Array;
}

/** The caller: a JS unit standing in for the entry point. It binds the callee only through `./bound.js`. */
export const CALLER = `// Caller unit (FORG-31 harness). Never changes when the callee's implementation does.
import { invoke, ready } from "./bound.js";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : null;
    switch (url.pathname) {
      case "/call":
        return Response.json(await invoke(body));
      case "/batch": {
        const out = [];
        for (const input of body) out.push(await invoke(input));
        return Response.json(out);
      }
      case "/ready": {
        const t0 = performance.now();
        await ready();
        return Response.json({ ms: performance.now() - t0 });
      }
      case "/bench": {
        const { input, n } = body;
        const t0 = performance.now();
        let last;
        for (let i = 0; i < n; i++) last = await invoke(input);
        return Response.json({ ms: performance.now() - t0, ok: last?.ok ?? null });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
`;

const enc = (s: string) => new TextEncoder().encode(s);

/** What the harness host provides as `@forgegraph/runtime`: `defineFunction`, as the runtime defines it. */
export const HOST_RUNTIME = `export function defineFunction(id, body, options = {}) { return { id, body, ...options }; }\n`;

/** The default host: provides no capability, so only a pure unit runs. */
export const NO_CAPABILITIES_HOST = `export function capability() { return null; }\n`;

/**
 * A host whose resource store is a D1 table, `env.DB` (FORG-36): `resource:<id>#read` handles
 * read `forge_harness_records(resource, id, body)`, where body is the record's wire JSON. A
 * missing row is `NotFound`, as the runtime's resource store reports it.
 */
export const D1_RESOURCE_HOST = `import { env } from "cloudflare:workers";
export const TABLE = "forge_harness_records";
export function capability(name) {
  const m = /^resource:(.+)#read$/.exec(name);
  if (!m) return null;
  const resource = m[1];
  const short = resource.slice(resource.lastIndexOf("/") + 1);
  return {
    async get(id) {
      const row = await env.DB.prepare("SELECT body FROM " + TABLE + " WHERE resource = ? AND id = ?").bind(resource, id).first();
      return row ? { ok: true, value: JSON.parse(row.body) } : { ok: false, code: "NotFound", detail: short + " " + id + " does not exist" };
    },
  };
}
`;

/** Creates the D1_RESOURCE_HOST table; run it against the Worker's `DB` before the first call. */
export const D1_RESOURCE_HOST_SCHEMA = "CREATE TABLE IF NOT EXISTS forge_harness_records (resource TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (resource, id))";

async function bundle(contents: string, resolveDir: string, external: string[], plugins: Plugin[] = []): Promise<Uint8Array> {
  const out = await build({
    stdin: { contents, resolveDir, sourcefile: "bound.js", loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    // `source`: workspace packages resolve to their TypeScript, as in the repo's tsconfig.
    conditions: ["workerd", "worker", "source", "import"],
    external,
    legalComments: "none",
    logLevel: "silent",
    plugins,
  });
  return out.outputFiles[0]!.contents;
}

export interface BoundUnit {
  kind: string;
  modules: WorkerModule[];
}

export interface BindOptions extends TranspileOptions {
  /** Source of `host.js`, which provides capability handles (default NO_CAPABILITIES_HOST). */
  host?: string;
}

/**
 * `bound.js`, the glue and the core modules for a transpiled component and its lowering (JSON
 * text). The glue's imports are the lowering's capabilities, bound to `host.js`'s handles.
 */
export async function transpiledModules(t: Transpiled, lowering: string): Promise<WorkerModule[]> {
  const cores = Object.keys(t.core).sort();
  const source = [
    `import { instantiate } from "./unit.js";`,
    `import { capability } from "./host.js";`,
    `import { bindExport, bindImports } from ${JSON.stringify(join(import.meta.dirname, "wit-lowering.ts"))};`,
    ...cores.map((n, i) => `import core${i} from ${JSON.stringify(`./${n}`)};`),
    `const cores = { ${cores.map((n, i) => `${JSON.stringify(n)}: core${i}`).join(", ")} };`,
    `const lowering = ${lowering.trim()};`,
    `let bound;`,
    `export async function ready() {`,
    `  if (bound) return;`,
    `  const imports = bindImports(lowering, Object.fromEntries(lowering.imports.map((i) => [i.capability, capability(i.capability)])));`,
    `  bound = bindExport(lowering, await instantiate((name) => cores[name], imports));`,
    `}`,
    `export async function invoke(input) {`,
    `  if (!bound) await ready();`,
    `  return bound(input);`,
    `}`,
  ].join("\n");
  const bound = await bundle(source, import.meta.dirname, ["./unit.js", "./host.js", "*.wasm"]);
  return [
    { type: "ESModule", path: "bound.js", contents: bound },
    { type: "ESModule", path: "unit.js", contents: t.glue },
    ...cores.map((n): WorkerModule => ({ type: "CompiledWasm", path: n, contents: t.core[n]! })),
  ];
}

/** The modules that run `symbol` from `sealed` behind CALLER. `appRoot` resolves shared libraries. */
export async function bindUnit(sealed: Sealed, symbol: string, appRoot: string, options: BindOptions = {}): Promise<BoundUnit> {
  const hash = sealed.bySymbol.get(symbol);
  const unit = hash ? sealed.manifest.units[hash] : undefined;
  if (!unit) throw new Error(`no unit ${symbol}`);
  const caller: WorkerModule = { type: "ESModule", path: "caller.js", contents: enc(CALLER) };
  const host: WorkerModule = { type: "ESModule", path: "host.js", contents: enc(options.host ?? NO_CAPABILITIES_HOST) };
  const blob = (digest: unknown) => {
    const b = sealed.modules.get(digest as string);
    if (!b) throw new Error(`${symbol}: blob ${String(digest)} is not in the sealed manifest`);
    return b;
  };

  if (unit.kind === "wasm-component") {
    const lowering = new TextDecoder().decode(blob(unit.implementation["lowering"]));
    const imports = asyncImports(JSON.parse(lowering) as Lowering);
    const t = await transpileComponent(blob(unit.implementation["component"]), { ...options, asyncImports: imports });
    const [bound, ...glue] = await transpiledModules(t, lowering);
    return { kind: unit.kind, modules: [caller, bound!, host, ...glue] };
  }

  if (unit.kind === "js-module") {
    const code = new TextDecoder().decode(blob(unit.implementation["module"]));
    // The sealed module, served under a virtual name, resolving its shared libraries from the app.
    // `@forgegraph/runtime` is a shared library the host provides. Its full entry carries every
    // storage adapter (the AWS SDK among them), so this host provides the surface a pure unit
    // reaches, `defineFunction`, with the runtime's own definition (packages/runtime/src/functions.ts).
    const sealedModule: Plugin = {
      name: "sealed-unit",
      setup(b) {
        b.onResolve({ filter: /^forge-unit:module$/ }, () => ({ path: "unit", namespace: "sealed-unit" }));
        b.onLoad({ filter: /.*/, namespace: "sealed-unit" }, () => ({ contents: code, loader: "js", resolveDir: appRoot }));
        b.onResolve({ filter: /^@forgegraph\/runtime$/ }, () => ({ path: "runtime", namespace: "host-runtime" }));
        b.onLoad({ filter: /.*/, namespace: "host-runtime" }, () => ({ contents: HOST_RUNTIME, loader: "js" }));
      },
    };
    // The FunctionContext the runtime builds (packages/runtime/src/functions.ts), over the host's
    // handles: the same handles the wasm-component binding imports.
    const source = `import impl from "forge-unit:module";
import { Effect } from "effect";
import { capability } from "./host.js";
const declared = ${JSON.stringify(unit.imports.map((i) => i.capability))};
const refuse = (what) => () => Effect.die(new Error(\`\${what} is not a declared capability of this unit\`));
const short = (id) => id.slice(id.lastIndexOf("/") + 1);
const handle = (name) => {
  const h = capability(name);
  if (!h) throw new Error(\`\${name} is a declared capability of this unit, and the host does not provide it\`);
  return h;
};
// A handle answers { ok, value } or { ok: false, code, detail }: the failure is the body's to handle.
const via = (h, f, ...args) => Effect.flatMap(Effect.promise(() => h[f](...args)), (r) => (r.ok ? Effect.succeed(r.value) : Effect.fail({ code: r.code, ...(r.detail === undefined ? {} : { detail: r.detail }) })));
let deps;
function bind() {
  const resources = {};
  const transitions = {};
  const externals = {};
  const sends = {};
  for (const c of declared) {
    let m;
    if ((m = /^resource:(.+)#(\\w+)$/.exec(c))) {
      const h = handle(c);
      const notLowered = (op) => () => Effect.die(new Error(\`\${op} on \${short(m[1])} has no harness handle\`));
      resources[short(m[1])] = { get: (id) => via(h, "get", id), find: notLowered("find"), list: notLowered("list"), create: notLowered("create"), update: notLowered("update"), delete: notLowered("delete") };
    } else if ((m = /^transition:(.+)\\.status\\.(.+)$/.exec(c))) {
      const h = handle(c);
      (transitions[short(m[1])] ??= {})[m[2]] = (id, expectedVersion, input) => via(h, "apply", id, expectedVersion, input);
    } else if ((m = /^function:(.+)$/.exec(c))) {
      const h = handle(c);
      externals[m[1]] = (input) => Effect.promise(() => h.call(input));
    } else if ((m = /^send:(.+)$/.exec(c))) {
      sends[m[1]] = handle(c);
    }
  }
  return { resources, transitions, externals, sends };
}
const context = (input) => ({
  input,
  ctx: {},
  resources: deps.resources,
  transitions: deps.transitions,
  external: (id, i) => (deps.externals[id] ?? refuse(\`external \${id}\`))(i),
  send: (channel, message, payload) => {
    const h = Object.entries(deps.sends).find(([k]) => k === \`\${channel}#\${message}\` || k.endsWith(\`/\${channel}#\${message}\`))?.[1];
    return h ? Effect.asVoid(via(h, "send", payload)) : refuse(\`send \${channel}#\${message}\`)();
  },
  fail: (code, detail) => Effect.fail({ code, detail }),
});
export async function ready() {
  deps ??= bind();
}
export async function invoke(input) {
  deps ??= bind();
  return Effect.runPromise(
    Effect.match(impl.body(context(input)), {
      onFailure: (e) => ({ ok: false, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) }),
      onSuccess: (value) => ({ ok: true, value: value ?? null }),
    }),
  );
}
`;
    const bound = await bundle(source, appRoot, ["./host.js"], [sealedModule]);
    return { kind: unit.kind, modules: [caller, { type: "ESModule", path: "bound.js", contents: bound }, host] };
  }

  throw new Error(`${symbol}: a ${unit.kind} unit has no harness binding`);
}
