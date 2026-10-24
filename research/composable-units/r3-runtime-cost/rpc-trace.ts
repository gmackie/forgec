// FORG-42: how many times the shared runtime Worker calls back into a script per request, over the
// 15 conformance scenarios in local workerd. Cloudflare caps a request at 32 Worker invocations and
// counts each service-binding call; whether a call on a stub received as an RPC parameter counts is
// not documented, so this records the worst case. Run after linking per-entry-point-shared (run.sh):
//   node --experimental-transform-types research/composable-units/r3-runtime-cost/rpc-trace.ts
// Writes results/rpc-trace.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

process.env["FORGE_RPC_TRACE"] = "1";
process.env["FORGE_MINIFLARE_LOG"] = "1"; // workerd console output, where the trace lines are
const root = resolve(import.meta.dirname, "../../..");
const client = await import(join(root, "conformance/fixtures/acme.client.ts"));
const { HttpTarget } = await import(join(root, "conformance/src/http-target.ts"));
const { runScenario } = await import(join(root, "conformance/src/runner.ts"));
const { loadScenarios } = await import(join(root, "conformance/src/scenarios.ts"));
const { readJsonc } = await import(join(root, "packages/linker-packed/src/link.ts"));
const { scriptsOf, serve } = await import(join(root, "packages/linker-packed/src/local.ts"));

// workerd's stdout reaches this process's stdout; keep the trace lines.
const rows: Array<{ script: string; what: string; callbacks: number }> = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  for (const m of String(chunk).matchAll(/forge-rpc (\{[^}]*\})/g)) rows.push(JSON.parse(m[1]!));
  return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const dir = join(root, "examples/acme/generated/linked/per-entry-point-shared");
const served = await serve(scriptsOf(JSON.parse(readFileSync(join(dir, "link.json"), "utf8")), dir), readJsonc(join(root, "examples/acme/deploy/cloudflare/wrangler.jsonc")), { secret: "r3-trace", migrations: join(root, "examples/acme/migrations/d1") });
const failed: string[] = [];
try {
  for (const s of loadScenarios()) {
    const r = await runScenario(s, new HttpTarget(client, served.url, "trace"), { tenant: `r3-${s.id}` });
    if (r.failures.length) failed.push(s.id);
  }
  await new Promise((r) => setTimeout(r, 2000)); // queue deliveries and waitUntil work
} finally {
  await served.close();
}
const c = rows.map((r) => r.callbacks).sort((a, b) => a - b);
const id = (s: string) => s.replace(/\b[a-z]{3}_[0-9a-z]{26}\b/g, "{id}").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}");
const out = {
  version: "r3-rpc-trace/1",
  issue: "FORG-42",
  measured: true,
  how: "the 15 conformance scenarios against per-entry-point-shared in local workerd with FORGE_RPC_TRACE=1; callbacks = calls the runtime Worker made back into the script's capability object during one request or batch (the router->script and script->runtime calls are not included)",
  scenariosFailed: failed,
  requests: rows.length,
  callbacks: { min: c[0] ?? 0, median: c[Math.floor(c.length / 2)] ?? 0, p95: c[Math.floor(c.length * 0.95)] ?? 0, max: c.at(-1) ?? 0 },
  over29: rows.filter((r) => r.callbacks > 29).length,
  top: [...rows].sort((a, b) => b.callbacks - a.callbacks).slice(0, 10).map((r) => ({ callbacks: r.callbacks, what: id(r.what), script: r.script })),
};
writeFileSync(join(import.meta.dirname, "results/rpc-trace.json"), `${JSON.stringify(out, null, 2)}\n`);
console.error(JSON.stringify({ requests: out.requests, callbacks: out.callbacks, over29: out.over29, failed }));
