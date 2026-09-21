#!/usr/bin/env node
/**
 * What `npm pack` would actually ship. Every publishable package must carry built output and its
 * own README + LICENSE, and must not ship tests or fixtures. Catches the classic broken publish
 * (an `exports` map pointing at `dist/` that was never built) before a version is burned.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dirs = [
  ...readdirSync("packages", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join("packages", d.name)),
  ...readdirSync("packages/contracts", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join("packages/contracts", d.name)),
];
let failed = false;
const fail = (m) => { console.error(`::error::${m}`); failed = true; };

for (const dir of dirs) {
  const f = join(dir, "package.json");
  if (!existsSync(f)) continue;
  const p = JSON.parse(readFileSync(f, "utf8"));
  if (p.private) { console.error(`${p.name}: private, not published`); continue; }
  const listing = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  const files = listing[0].files.map((x) => x.path);
  const has = (re) => files.some((x) => re.test(x));
  if (!has(/^dist\/.*\.js$/)) fail(`${p.name}: no built JavaScript in the tarball (run the package build)`);
  if (!has(/^dist\/.*\.d\.ts$/)) fail(`${p.name}: no type declarations in the tarball`);
  if (!files.includes("README.md")) fail(`${p.name}: no README.md`);
  if (!files.includes("LICENSE")) fail(`${p.name}: no LICENSE`);
  if (has(/^(test|tests)\//)) fail(`${p.name}: tests are in the tarball`);
  if (!p.repository?.directory) fail(`${p.name}: repository.directory is required so npm links to the right subdirectory`);
  if (p.publishConfig?.access !== "public") fail(`${p.name}: publishConfig.access must be "public" for a scoped package`);
  // every exports target must exist on disk
  for (const [key, e] of Object.entries(p.exports ?? {})) {
    const targets = typeof e === "string" ? [e] : Object.values(e);
    for (const t of targets) {
      if (typeof t !== "string" || t.startsWith("#")) continue;
      if (!existsSync(join(dir, t))) fail(`${p.name}: exports["${key}"] -> ${t} does not exist`);
    }
  }
  console.error(`${p.name}: ${files.length} files, ${(listing[0].size / 1024).toFixed(0)} KiB`);
}
process.exit(failed ? 1 : 0);
