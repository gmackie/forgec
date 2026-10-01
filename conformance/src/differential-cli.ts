/** Publish certification only after every assertion in this invocation passes. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runDifferentialCli(root: string, run?: () => { status: number | null }): number {
  const path = resolve(root, "reports/differential.json");
  const candidate = resolve(root, "reports/differential-candidate.json");
  const raw = resolve(root, "reports/differential-suite.json");
  mkdirSync(resolve(root, "reports"), { recursive: true });
  for (const file of [path, candidate, raw]) rmSync(file, { force: true });
  const r = run ? run() : spawnSync("pnpm", ["exec", "vitest", "run", "test/differential.test.ts", "--reporter=default", "--reporter=json", `--outputFile=${raw}`], { cwd: root, env: { ...process.env, FORGE_DIFFERENTIAL_WRITE: "1" }, encoding: "utf8", stdio: "inherit" });
  try {
    if (r.status !== 0 || !existsSync(candidate) || !existsSync(raw)) return 1;
    const suite = JSON.parse(readFileSync(raw, "utf8"));
    const assertions = (suite.testResults ?? []).flatMap((t: { assertionResults?: { status: string }[] }) => t.assertionResults ?? []);
    if (suite.success !== true || suite.numFailedTests !== 0 || suite.numPendingTests !== 0 || suite.numTodoTests !== 0 || assertions.length !== 2 || assertions.some((a: { status: string }) => a.status !== "passed")) return 1;
    const report = JSON.parse(readFileSync(candidate, "utf8"));
    if (report.drift !== "none") return 1;
    writeFileSync(path, JSON.stringify({ ...report, suitePassed: true }, null, 2) + "\n");
    console.error(JSON.stringify({ drift: report.drift, profiles: report.profiles, pairs: report.pairs }, null, 2));
    return 0;
  } finally { rmSync(candidate, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runDifferentialCli(resolve(import.meta.dirname, ".."));
