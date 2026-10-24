// FORG-30 API probe: what the pinned workerd's Worker Loader does with no compatibility flags.
// wrangler dev --config research/composable-units/t4-linker-dynamic/probe/wrangler.jsonc --local --port 8931
// then GET / returns one JSON object of observations.
import { WorkerEntrypoint } from "cloudflare:workers";
import { createHash } from "node:crypto";

export class Cap extends WorkerEntrypoint {
  async hello(x) {
    return `cap:${this.ctx.props.tag}:${x}`;
  }
}

const childModules = {
  "main.js": `import { lib } from "@forgegraph/runtime";
import { e } from "effect";
import unit from "./u-abc.js";
import app from "./app.json";
import { env as importedEnv, WorkerEntrypoint } from "cloudflare:workers";
import { createHash } from "node:crypto";
export class Forge extends WorkerEntrypoint { async ping(x) { return "pong:" + x; } }
export default {
  async fetch(request, env) {
    let fetchResult;
    try { await fetch("https://example.com/"); fetchResult = "allowed"; } catch (err) { fetchResult = "threw: " + err.message; }
    return Response.json({
      resolution: { lib, e, unit: unit(), app },
      envKeys: Object.keys(env),
      importedEnvKeys: Object.keys(importedEnv),
      cap: await env.CAP.hello("x"),
      fetch: fetchResult,
      nodeCrypto: createHash("sha256").update("x").digest("hex").slice(0, 8),
      hostBindingsVisible: ["LOADER"].filter((k) => k in env || k in globalThis),
    });
  },
};`,
  // A module named "@forgegraph/runtime" lives in directory "@forgegraph/", so its bare "effect"
  // would resolve to "@forgegraph/effect"; "../effect" reaches the root module.
  "@forgegraph/runtime": { js: `import { e } from "../effect"; export const lib = "runtime+" + e;` },
  effect: { js: `export const e = "effect";` },
  "u-abc.js": `import { e } from "effect"; export default () => "unit+" + e;`,
  "app.json": { json: { buildHash: "x" } },
};

export default {
  async fetch(request, env, ctx) {
    const out = { hostHasLoader: typeof env.LOADER?.get, hostHasCtxExports: typeof ctx.exports?.Cap, hostNodeCrypto: createHash("sha256").update("x").digest("hex").slice(0, 8) };
    try {
      let calls = 0;
      const get = () => env.LOADER.get("probe-1", () => {
        calls++;
        return { compatibilityDate: "2026-09-25", mainModule: "main.js", modules: childModules, env: { CAP: ctx.exports.Cap({ props: { tag: "t1" } }) }, globalOutbound: null };
      });
      out.child = await (await get().getEntrypoint().fetch("http://child/")).json();
      out.namedEntrypointRpc = await get().getEntrypoint("Forge").ping(1);
      out.codeCallbackCallsForTwoGets = calls;
      const bad = env.LOADER.get("probe-bad", () => ({ compatibilityDate: "2026-09-25", mainModule: "main.js", modules: { "main.js": `import x from "./missing.js"; export default { fetch() { return new Response(x); } }` }, globalOutbound: null }));
      try {
        await bad.getEntrypoint().fetch("http://child/");
        out.missingModule = "loaded";
      } catch (err) {
        out.missingModule = "threw: " + String(err.message).split("\n")[0];
      }
    } catch (err) {
      out.error = String(err.stack || err);
    }
    return Response.json(out);
  },
};
