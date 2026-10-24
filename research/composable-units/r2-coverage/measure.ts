// FORG-33 measurements for examples/acme: manifest coverage before and after, and a check of every
// unit's source spans against the working tree. Run from the repository root after
// `cargo build -p forgegraph-cli` and `pnpm install`:
//   node research/composable-units/r2-coverage/measure.ts
// Writes results/coverage.json. `results/baseline-main.json` is the same summary of the manifest
// sealed on main 0f8a3e4, before this change (kept, not regenerated: it needs the old compiler).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { seal, stableJson, writeSealed, type ClosureManifest, type UnitPlan } from "../../../packages/units/src/index.ts";
import { summarize } from "./summarize.ts";

const root = resolve(import.meta.dirname, "../../..");
const here = import.meta.dirname;
const app = join(root, "examples/acme");
const roots: Record<string, string> = { "@acme/commerce": app, "@acme/payments": join(root, "examples/payments") };

execFileSync(join(root, "target/debug/forgec"), ["build", app, "--units"], { stdio: "pipe" });
const out = join(app, "generated/units");
const sealed = await seal(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")) as UnitPlan, app);
writeSealed(sealed, out);
const m: ClosureManifest = sealed.manifest;

// Every span against the files in the working tree: the blob hash is git's, and the span holds the
// declaration (or, for a body, the definition) of the unit.
const checks = { spans: 0, blobsMatchingGit: 0, problems: [] as string[] };
for (const u of Object.values(m.units)) {
  for (const s of u.sources) {
    checks.spans++;
    const file = join(roots[s.package ?? m.package.name]!, s.path);
    if (execFileSync("git", ["hash-object", file], { encoding: "utf8" }).trim() === s.gitBlob) checks.blobsMatchingGit++;
    else checks.problems.push(`${u.symbol}: ${s.path} blob ${s.gitBlob} is not git's`);
    const text = readFileSync(file).subarray(s.start, s.end).toString("utf8");
    const name = u.role === "operation" ? u.symbol.slice(u.symbol.lastIndexOf("/") + 1).split(".")[0]! : u.symbol.slice(u.symbol.lastIndexOf("/") + 1);
    const ok = s.part === "body" ? text.includes(u.symbol) || /^export (const|async function|function) /.test(text) : new RegExp(`\\b${name}\\b`).test(text);
    if (!ok) checks.problems.push(`${u.symbol}: ${s.part} span ${s.path}[${s.start},${s.end}) does not hold its definition`);
  }
}

const baseline = JSON.parse(readFileSync(join(here, "results/baseline-main.json"), "utf8"));
const after = summarize(m as never);
writeFileSync(join(here, "results/coverage.json"), stableJson({ version: "r2-coverage/1", issue: "FORG-33", before: baseline, after, sourceChecks: checks }));
console.log(JSON.stringify({ before: { units: baseline.units.total, entryPoints: baseline.entryPoints.total, uncovered: baseline.uncovered.length, servedByRuntimeAlone: baseline.servedByRuntimeAlone.length }, after: { units: after.units.total, entryPoints: after.entryPoints.total, uncovered: after.uncovered.length, servedByRuntimeAlone: after.servedByRuntimeAlone.length }, sourceChecks: { spans: checks.spans, blobsMatchingGit: checks.blobsMatchingGit, problems: checks.problems.length } }, null, 1));
if (checks.problems.length) {
  console.error(checks.problems.join("\n"));
  process.exitCode = 1;
}
