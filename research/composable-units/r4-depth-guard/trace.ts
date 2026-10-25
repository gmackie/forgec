// FORG-49: the depth and the cross-script calls of every shared request, queue batch and cron over the
// 15 conformance scenarios in local workerd, as the shared host's depth guard records them
// (packages/linker-packed/src/shared/script.ts, FORGE_RPC_TRACE). FORG-42's version
// (../r3-runtime-cost/rpc-trace.ts) counted calls against a 29-call budget; this one records the stage
// each script ran at, the deepest stage it started, and its calls, which nothing limits now. Run after
// linking per-entry-point-shared (run.sh):
//   node --experimental-transform-types research/composable-units/r4-depth-guard/trace.ts
// Writes results/trace.json. Local workerd: Miniflare does not enforce Cloudflare's depth limit, so the
// limit itself is FORG-38's deployed measurement (../r4-deployed/, section 5).
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
const { MAX_DEPTH } = await import(join(root, "packages/linker-packed/src/shared/script.ts"));

type Row = { script: string; what: string; depth: number; deepest: number; calls: number; refused: string | null };
const rows: Row[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  for (const m of String(chunk).matchAll(/forge-rpc (\{[^}]*\})/g)) rows.push(JSON.parse(m[1]!));
  return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const dir = join(root, "examples/acme/generated/linked/per-entry-point-shared");
const link = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
const served = await serve(scriptsOf(link, dir), readJsonc(join(root, "examples/acme/deploy/cloudflare/wrangler.jsonc")), { secret: "r4-trace", migrations: join(root, "examples/acme/migrations/d1") });
const failed: string[] = [];
try {
  for (const s of loadScenarios()) {
    const r = await runScenario(s, new HttpTarget(client, served.url, "trace"), { tenant: `r4-${s.id}` });
    if (r.failures.length) failed.push(s.id);
  }
  await new Promise((r) => setTimeout(r, 2000)); // queue deliveries and waitUntil work
} finally {
  await served.close();
}
const dist = (xs: number[]) => {
  const c = [...xs].sort((a, b) => a - b);
  return { min: c[0] ?? 0, median: c[Math.floor(c.length / 2)] ?? 0, p95: c[Math.floor(c.length * 0.95)] ?? 0, max: c.at(-1) ?? 0 };
};
const id = (s: string) => s.replace(/\b[a-z]{3}_[0-9a-z]{26}\b/g, "{id}").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "{id}");
const kind = (r: Row) => (r.what === "scheduled" ? "cron" : r.what.startsWith("queue ") ? "queue" : "http");
const kinds = ["http", "queue", "cron"].map((k) => [k, rows.filter((r) => kind(r) === k)] as const);
const out = {
  version: "r4-depth-guard-trace/1",
  issue: "FORG-49",
  local: true,
  how: "the 15 conformance scenarios against per-entry-point-shared in local workerd with FORGE_RPC_TRACE=1. depth = the Workers stage the shared script ran at (router 1, so a routed request is 2; a queue batch or cron is 1); deepest = the deepest stage it started (the runtime Worker, a dispatch hand-off or a Durable Object, all one stage below the script); calls = its cross-script calls (the runtime call, callbacks, unit deps calls, hand-offs), which nothing limits.",
  maxDepth: MAX_DEPTH,
  scenariosFailed: failed,
  requests: rows.length,
  byKind: Object.fromEntries(kinds.map(([k, rs]) => [k, { count: rs.length, depth: dist(rs.map((r) => r.depth)), deepest: dist(rs.map((r) => r.deepest)), calls: dist(rs.map((r) => r.calls)) }])),
  deepest: dist(rows.map((r) => r.deepest)),
  calls: dist(rows.map((r) => r.calls)),
  over29Calls: rows.filter((r) => r.calls >= 30).map((r) => ({ calls: r.calls, deepest: r.deepest, what: id(r.what), script: r.script })),
  refused: rows.filter((r) => r.refused).map((r) => ({ what: id(r.what), script: r.script, refused: r.refused })),
  top: [...rows].sort((a, b) => b.calls - a.calls).slice(0, 10).map((r) => ({ calls: r.calls, deepest: r.deepest, what: id(r.what), script: r.script })),
};
writeFileSync(join(import.meta.dirname, "results/trace.json"), `${JSON.stringify(out, null, 2)}\n`);
console.error(JSON.stringify({ requests: out.requests, deepest: out.deepest, calls: out.calls, over29: out.over29Calls.length, refused: out.refused.length, failed }));
