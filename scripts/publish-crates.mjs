#!/usr/bin/env node
/**
 * Publish the crates in dependency order, waiting for the index between steps so the next crate can
 * resolve the one before it. Already-published versions are skipped, so a re-run after a partial
 * failure completes the release instead of failing on the first crate.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ORDER = ["forge-syntax", "forge-semantic", "forge-planner", "forge-codegen", "forgegraph-cli"];
const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("Cargo.toml", "utf8").split("[workspace.package]")[1])[1];
const dry = process.env.DRY_RUN === "true";

const published = async (crate) => {
  const res = await fetch(`https://crates.io/api/v1/crates/${crate}/${version}`, { headers: { "user-agent": "forgegraph-release" } });
  return res.status === 200;
};

for (const crate of ORDER) {
  if (await published(crate)) {
    console.error(`${crate} ${version} is already published; skipping`);
    continue;
  }
  console.error(`publishing ${crate} ${version}${dry ? " (dry run)" : ""}`);
  execFileSync("cargo", ["publish", "-p", crate, "--locked", ...(dry ? ["--dry-run"] : [])], { stdio: "inherit" });
  if (dry) continue;
  process.stderr.write(`waiting for ${crate} ${version} on the index`);
  for (let i = 0; i < 60; i++) {
    if (await published(crate)) { process.stderr.write(" ok\n"); break; }
    process.stderr.write(".");
    await new Promise((r) => setTimeout(r, 5000));
    if (i === 59) throw new Error(`${crate} ${version} did not appear on the index`);
  }
  execSync("cargo update -w --quiet || true", { stdio: "inherit" });
}
console.error("crates published");
