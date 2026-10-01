/**
 * Certification run (plan M8 gate): both targets must pass the declared
 * portable profile and emit a machine-readable conformance report. Runs the
 * reference suites, every scenario against each live deployment, the realtime
 * profile, provider switching in both directions, and the benchmarks; then
 * writes conformance/certification/latest.json (source-controlled).
 *
 *   FORGE_CF_URL=https://... FORGE_CF_WS=wss://... \
 *   FORGE_AWS_URL=https://... FORGE_AWS_WS=wss://... pnpm certify
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { certificationIdentity } from "../../scripts/certification-identity.mjs";

import { completeSuite, currentScenarios, verifyEndpointBuild } from "./certification-gates.mjs";

const root = resolve(import.meta.dirname, "..");
const targets = [
  { name: "cloudflare-d1", url: process.env["FORGE_CF_URL"], ws: process.env["FORGE_CF_WS"], stack: "Workers + D1 + R2 + Queues + Workflows + Cron Triggers + Durable Objects" },
  { name: "aws-dynamodb", url: process.env["FORGE_AWS_URL"], ws: process.env["FORGE_AWS_WS"], stack: "HTTP API + Lambda + DynamoDB + S3 + SQS + Step Functions + EventBridge + API Gateway WebSocket" },
].filter((t) => t.url);
if (targets.length < 2) throw new Error("FORGE_CF_URL and FORGE_AWS_URL are required for a certification run");

const evidenceDir = resolve(root, "certification/live");
mkdirSync(evidenceDir, { recursive: true });
const invocations: { ref: string; ok: boolean; files: string[] }[] = [];
let runNo = 0;
function vitest(files: string[], env: Record<string, string | undefined>): { ok: boolean; output: string } {
  const outFile = resolve(root, "reports", `live-suite-${++runNo}.json`);
  mkdirSync(resolve(root, "reports"), { recursive: true });
  rmSync(outFile, { force: true });
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...files, "--reporter=json", `--outputFile=${outFile}`], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let ok = r.status === 0;
  try {
    const j = JSON.parse(readFileSync(outFile, "utf8")) as { numFailedTests: number; numPassedTests: number };
    ok = ok && completeSuite(j);
    copyFileSync(outFile, resolve(evidenceDir, `suite-${runNo}.json`));
  } catch {
    ok = false;
  }
  invocations.push({ ref: `conformance/certification/live/suite-${runNo}.json`, ok, files });
  console.error(JSON.stringify({ files, ok }));
  if (!ok) console.error((r.stdout + r.stderr).slice(-4000));
  return { ok, output: (r.stdout + r.stderr).slice(-2000) };
}

const bundle = JSON.parse(readFileSync(resolve(root, "fixtures", "acme.app.json"), "utf8")) as { buildHash: string; ir: { package: { name: string; version: string; profile: string } }; contracts: { version: string } };
const commit = (() => {
  for (const [cmd, args] of [["jj", ["log", "--no-pager", "-r", "@-", "--no-graph", "-T", "commit_id"]], ["git", ["rev-parse", "HEAD"]]] as const) {
    try { const v = execFileSync(cmd, [...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); if (/^[0-9a-f]{40}$/.test(v)) return v; } catch { /* next */ }
  }
  return "unknown";
})();

const identity = certificationIdentity(resolve(root, ".."));
const report: Record<string, unknown> = {
  ...identity,
  version: "certification/1",
  at: new Date().toISOString(),
  commit,
  package: bundle.ir.package,
  buildHash: bundle.buildHash,
  contractsVersion: bundle.contracts.version,
  profile: bundle.ir.package.profile,
};

const suites: Record<string, unknown> = {};
suites["reference"] = vitest(["test/runner.test.ts", "test/vectors.test.ts", "test/migrations.test.ts"], {}).ok;
const perTarget: Record<string, unknown> = {};
for (const t of targets) {
  const endpointBuild = await verifyEndpointBuild(t.url!, identity.buildHash);
  rmSync(resolve(root, "reports", `${t.name}.json`), { force: true });
  rmSync(resolve(root, "reports", `bench-${t.name}.json`), { force: true });
  const scenarios = vitest(["test/remote.test.ts"], { FORGE_TARGET_URL: t.url, FORGE_TARGET_NAME: t.name });
  const realtime = t.ws ? vitest(["test/realtime.test.ts"], { FORGE_TARGET_URL: t.url, FORGE_TARGET_WS: t.ws }) : { ok: false, output: "no FORGE_*_WS" };
  const scenarioReport = existsSync(resolve(root, "reports", `${t.name}.json`)) ? (JSON.parse(readFileSync(resolve(root, "reports", `${t.name}.json`), "utf8")) as { scenarios: { id: string; steps: number; failures: unknown[] }[] }) : null;
  spawnSync("node", ["--experimental-strip-types", "src/bench.ts"], { cwd: root, env: { ...process.env, FORGE_TARGET_URL: t.url, FORGE_TARGET_NAME: t.name }, encoding: "utf8" });
  const bench = existsSync(resolve(root, "reports", `bench-${t.name}.json`)) ? JSON.parse(readFileSync(resolve(root, "reports", `bench-${t.name}.json`), "utf8")) : null;
  if (scenarioReport) copyFileSync(resolve(root, "reports", `${t.name}.json`), resolve(evidenceDir, `${t.name}.json`));
  await verifyEndpointBuild(t.url!, identity.buildHash);
  perTarget[t.name] = {
    endpointBuild,
    url: t.url,
    stack: t.stack,
    scenarios: { ok: scenarios.ok && currentScenarios(scenarioReport, identity.scenarioIds), count: scenarioReport?.scenarios.length ?? 0, steps: scenarioReport?.scenarios.reduce((n, s) => n + s.steps, 0) ?? 0, failures: scenarioReport?.scenarios.reduce((n, s) => n + s.failures.length, 0) ?? 0, ids: scenarioReport?.scenarios.map((s) => s.id).sort() ?? [] },
    realtime: realtime.ok,
    bench: bench ? { latencyMs: bench.latencyMs, atomicBudget: bench.atomicBudget } : null,
  };
}
const [a, b] = targets;
suites["switch"] = {
  [`${a!.name}->${b!.name}`]: vitest(["test/switch.test.ts"], { FORGE_SOURCE_URL: a!.url, FORGE_TARGET_URL: b!.url }).ok,
  [`${b!.name}->${a!.name}`]: vitest(["test/switch.test.ts"], { FORGE_SOURCE_URL: b!.url, FORGE_TARGET_URL: a!.url }).ok,
};
report["invocations"] = invocations;
report["suites"] = suites;
report["targets"] = perTarget;
const all = [suites["reference"] as boolean, ...Object.values(suites["switch"] as Record<string, boolean>), ...Object.values(perTarget).map((t) => (t as { scenarios: { ok: boolean }; realtime: boolean }).scenarios.ok && (t as { realtime: boolean }).realtime)];
report["certified"] = all.every(Boolean) && JSON.stringify(identity) === JSON.stringify(certificationIdentity(resolve(root, "..")));

mkdirSync(resolve(root, "certification"), { recursive: true });
writeFileSync(resolve(root, "certification", "latest.json"), JSON.stringify(report, null, 2) + "\n");
console.error(JSON.stringify({ certified: report["certified"], suites, targets: Object.fromEntries(Object.entries(perTarget).map(([k, v]) => [k, { scenarios: (v as { scenarios: unknown }).scenarios, realtime: (v as { realtime: boolean }).realtime }])) }, null, 2));
if (!report["certified"]) process.exit(1);
