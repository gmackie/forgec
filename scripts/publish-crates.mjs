#!/usr/bin/env node
/**
 * Publish the crates in dependency order, waiting for the index between steps so the next crate
 * can resolve the one before it. Already-published versions are skipped, so a re-run after a
 * partial failure completes the release instead of failing on the first crate.
 *
 * Dry runs are necessarily partial. `cargo publish --dry-run` resolves the packaged crate's
 * dependencies against the registry, and a sibling that has never been published is not there —
 * so only crates whose siblings are already up can be verified this way. That is a property of
 * cargo, not a fault in the release, and it is reported as unverified rather than as failure.
 * `cargo package --workspace` (run in CI) is what checks that those crates build from their own
 * tarballs.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ORDER = ["forgegraph-syntax", "forgegraph-semantic", "forgegraph-planner", "forgegraph-codegen", "forgegraph-cli"];
const version = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync("Cargo.toml", "utf8").split("[workspace.package]")[1])[1];
const dry = process.env.DRY_RUN === "true";

const published = async (crate) => {
  const res = await fetch(`https://crates.io/api/v1/crates/${crate}/${version}`, { headers: { "user-agent": "forgegraph-release" } });
  return res.status === 200;
};

const unverified = [];
for (const [i, crate] of ORDER.entries()) {
  if (await published(crate)) {
    console.error(`${crate} ${version} is already published; skipping`);
    continue;
  }

  if (dry) {
    // Every crate before this one in the order is a dependency that must already exist.
    const missing = [];
    for (const dep of ORDER.slice(0, i)) if (!(await published(dep))) missing.push(dep);
    if (missing.length) {
      console.error(`${crate}: not verifiable by dry run until ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} published`);
      unverified.push(crate);
      continue;
    }
  }

  console.error(`publishing ${crate} ${version}${dry ? " (dry run)" : ""}`);
  execFileSync("cargo", ["publish", "-p", crate, "--locked", ...(dry ? ["--dry-run"] : [])], { stdio: "inherit" });
  if (dry) continue;

  process.stderr.write(`waiting for ${crate} ${version} on the index`);
  for (let i = 0; i < 60; i++) {
    if (await published(crate)) {
      process.stderr.write(" ok\n");
      break;
    }
    process.stderr.write(".");
    await new Promise((r) => setTimeout(r, 5000));
    if (i === 59) throw new Error(`${crate} ${version} did not appear on the index`);
  }
}

if (unverified.length) {
  console.error(`\ndry run complete. Not verified here (cargo cannot resolve an unpublished sibling): ${unverified.join(", ")}.`);
  console.error("`cargo package --workspace` verifies those build from their own tarballs; the real publish resolves them in order.");
} else {
  console.error(dry ? "\ndry run complete" : "\ncrates published");
}
