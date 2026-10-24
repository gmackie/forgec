// FORG-42 probe: what Workers RPC lets a packed script hand a shared runtime Worker, in local workerd.
import { createRequire } from "node:module";
const { Miniflare, convertV4MiniflareOptions } = createRequire(new URL("../../../../packages/linker-packed/package.json", import.meta.url))("miniflare");
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const here = import.meta.dirname;
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
  { name: "caller", modules: true, rootPath: here, scriptPath: join(here, "caller.js"), compatibilityDate: "2026-09-01", d1Databases: { DB: "probe" }, serviceBindings: { RUNTIME: "runtime" } },
  { name: "runtime", modules: true, rootPath: here, scriptPath: join(here, "callee.js"), compatibilityDate: "2026-09-01" },
] }));
const res = await mf.dispatchFetch("http://localhost/");
const out = await res.json();
await mf.dispose();
console.log(JSON.stringify(out, null, 2));
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ version: "r3-rpc-probe/1", issue: "FORG-42", measured: true, compatibilityDate: "2026-09-01", result: out }, null, 2) + "\n");
