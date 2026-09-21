#!/usr/bin/env node
/**
 * One version per release. Compares the tag against the Cargo workspace version and every
 * publishable package.json, and writes `version=<v>` for the workflow. Any disagreement fails:
 * a half-versioned release is how a registry ends up with artifacts that cannot be reproduced.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("Cargo.toml", "utf8").split("[workspace.package]")[1] ?? "")?.[1];

// With a tag: everything must equal the tag. Without one (a manual rehearsal, where
// GITHUB_REF_NAME is a branch): everything must equal the workspace version. The second
// form still catches Cargo.toml and the package.json files drifting apart, which is the
// failure this guards against — it just cannot check the tag that does not exist yet.
const arg = (process.argv[2] ?? "").replace(/^v/, "");
const tag = arg || cargo;
const problems = [];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
  console.error(arg ? `tag "${process.argv[2]}" is not v<semver>` : `Cargo.toml [workspace.package] version "${cargo}" is not semver`);
  process.exit(1);
}
if (cargo !== tag) problems.push(`Cargo.toml workspace version ${cargo} != ${tag}`);

const dirs = [
  ...readdirSync("packages", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join("packages", d.name)),
  ...readdirSync("packages/contracts", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join("packages/contracts", d.name)),
];
for (const dir of dirs) {
  const f = join(dir, "package.json");
  if (!existsSync(f)) continue;
  const p = JSON.parse(readFileSync(f, "utf8"));
  if (p.private) continue;
  if (p.version !== tag) problems.push(`${p.name} version ${p.version} != ${tag}`);
}
if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`version=${tag}`);
