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
// ---- crates ----------------------------------------------------------------
// Cargo pulls the workspace README into each tarball but not the workspace LICENSE, so a crate
// can ship declaring Apache-2.0 while carrying no copy of it. Apache-2.0 requires the copy.
const crateDirs = readdirSync("crates", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
for (const dir of crateDirs) {
  const toml = readFileSync(join("crates", dir, "Cargo.toml"), "utf8");
  if (/^publish\s*=\s*false/m.test(toml)) { console.error(`crates/${dir}: publish = false`); continue; }
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? dir;
  let listing;
  try {
    listing = execFileSync("cargo", ["package", "-p", name, "--locked", "--allow-dirty", "--list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
  } catch {
    fail(`${name}: cargo package --list failed`);
    continue;
  }
  if (!listing.includes("LICENSE")) fail(`${name}: no LICENSE in the crate tarball (copy the workspace LICENSE into crates/${dir}/)`);
  if (!listing.includes("README.md")) fail(`${name}: no README.md in the crate tarball`);
  if (!/^license\s*=\s*"/m.test(toml) && !/license\.workspace\s*=\s*true/.test(toml)) fail(`${name}: no license field`);
  console.error(`${name}: ${listing.filter(Boolean).length} files`);
}

process.exit(failed ? 1 : 0);
