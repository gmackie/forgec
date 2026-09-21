/** `pnpm differential`: run the differential certification through vitest (source-condition resolution) and print the report. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const r = spawnSync("pnpm", ["exec", "vitest", "run", "test/differential.test.ts"], { cwd: root, env: { ...process.env, FORGE_DIFFERENTIAL_WRITE: "1" }, encoding: "utf8", stdio: "inherit" });

// The suite writes the report as its last act, so a failing run may leave none. Reporting that
// as ENOENT buries the actual failure under a stack trace about a missing file — the run above
// already said what went wrong, and this should not talk over it.
const path = resolve(root, "reports", "differential.json");
if (!existsSync(path)) {
  console.error(
    r.status === 0
      ? `the differential suite passed but wrote no report at ${path}`
      : "the differential suite failed before it could write a report; the failure is above",
  );
  process.exit(1);
}

const report = JSON.parse(readFileSync(path, "utf8")) as { drift: string; profiles: unknown; pairs: unknown };
console.error(JSON.stringify({ drift: report.drift, profiles: report.profiles, pairs: report.pairs }, null, 2));
process.exit(r.status === 0 && report.drift === "none" ? 0 : 1);
