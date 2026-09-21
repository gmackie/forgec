/** `pnpm differential`: run the differential certification through vitest (source-condition resolution) and print the report. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const r = spawnSync("pnpm", ["exec", "vitest", "run", "test/differential.test.ts"], { cwd: root, env: { ...process.env, FORGE_DIFFERENTIAL_WRITE: "1" }, encoding: "utf8", stdio: "inherit" });
const report = JSON.parse(readFileSync(resolve(root, "reports", "differential.json"), "utf8")) as { drift: string; profiles: unknown; pairs: unknown };
console.error(JSON.stringify({ drift: report.drift, profiles: report.profiles, pairs: report.pairs }, null, 2));
process.exit(r.status === 0 && report.drift === "none" ? 0 : 1);
