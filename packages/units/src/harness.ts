// Stands in for a linker (FORG-31): turns one unit of a sealed manifest into the Worker modules
// that run it behind a fixed caller. The caller module is the same bytes whatever the unit's
// kind; only `bound.js`, which the linker generates, differs:
//
//   js-module       the sealed module bundled with its shared libraries, run through Effect
//   wasm-component  the component transpiled to core module(s) + jco glue, instantiated from
//                   precompiled module imports and adapted to wire values by its lowering
//
// Both export `invoke(input): Promise<UnitResult>` and `ready()`. Capability handles are not
// wired here: the T5 unit is pure, and a unit that reaches for one fails closed.
import { build, type Plugin } from "esbuild";
import { join } from "node:path";
import type { Sealed } from "./seal.ts";
import { transpileComponent, type TranspileOptions } from "./wasm.ts";

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

/** The modules that run `symbol` from `sealed` behind CALLER. `appRoot` resolves shared libraries. */
export async function bindUnit(sealed: Sealed, symbol: string, appRoot: string, options: TranspileOptions = {}): Promise<BoundUnit> {
  const hash = sealed.bySymbol.get(symbol);
  const unit = hash ? sealed.manifest.units[hash] : undefined;
  if (!unit) throw new Error(`no unit ${symbol}`);
  const caller: WorkerModule = { type: "ESModule", path: "caller.js", contents: enc(CALLER) };
  const blob = (digest: unknown) => {
    const b = sealed.modules.get(digest as string);
    if (!b) throw new Error(`${symbol}: blob ${String(digest)} is not in the sealed manifest`);
    return b;
  };

  if (unit.kind === "wasm-component") {
    const t = await transpileComponent(blob(unit.implementation["component"]), options);
    const lowering = new TextDecoder().decode(blob(unit.implementation["lowering"]));
    const cores = Object.keys(t.core).sort();
    const source = [
      `import { instantiate } from "./unit.js";`,
      `import { bindExport } from ${JSON.stringify(join(import.meta.dirname, "wit-lowering.ts"))};`,
      ...cores.map((n, i) => `import core${i} from ${JSON.stringify(`./${n}`)};`),
      `const cores = { ${cores.map((n, i) => `${JSON.stringify(n)}: core${i}`).join(", ")} };`,
      `const lowering = ${lowering.trim()};`,
      `let bound;`,
      `export async function ready() {`,
      `  if (!bound) bound = bindExport(lowering, await instantiate((name) => cores[name], {}));`,
      `}`,
      `export async function invoke(input) {`,
      `  if (!bound) await ready();`,
      `  return bound(input);`,
      `}`,
    ].join("\n");
    const bound = await bundle(source, import.meta.dirname, ["./unit.js", "*.wasm"]);
    return {
      kind: unit.kind,
      modules: [
        caller,
        { type: "ESModule", path: "bound.js", contents: bound },
        { type: "ESModule", path: "unit.js", contents: t.glue },
        ...cores.map((n): WorkerModule => ({ type: "CompiledWasm", path: n, contents: t.core[n]! })),
      ],
    };
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
    const source = `import impl from "forge-unit:module";
import { Effect } from "effect";
const refuse = (what) => () => Effect.die(new Error(\`\${what} is not a declared capability of this unit\`));
const context = (input) => ({
  input,
  ctx: {},
  resources: {},
  transitions: {},
  external: refuse("external"),
  send: refuse("send"),
  fail: (code, detail) => Effect.fail({ code, detail }),
});
export async function ready() {}
export async function invoke(input) {
  return Effect.runPromise(
    Effect.match(impl.body(context(input)), {
      onFailure: (e) => ({ ok: false, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) }),
      onSuccess: (value) => ({ ok: true, value: value ?? null }),
    }),
  );
}
`;
    const bound = await bundle(source, appRoot, [], [sealedModule]);
    return { kind: unit.kind, modules: [caller, { type: "ESModule", path: "bound.js", contents: bound }] };
  }

  throw new Error(`${symbol}: a ${unit.kind} unit has no harness binding`);
}
