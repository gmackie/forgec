#!/usr/bin/env node
/**
 * Every workspace crate must be publishable under its own name *before* a release starts.
 *
 * crates.io publishes are permanent — you can yank a version but never free a name, and never
 * take one back. `scripts/publish-crates.mjs` publishes in dependency order, so a name that
 * turns out to be taken fails partway through, after the crates before it are already up and
 * irreversible. That is exactly what nearly happened here: `forge-codegen` was taken (by an
 * unrelated "Forge framework" TypeScript generator), and it was the fourth of five.
 *
 * So: ask crates.io about every name up front. A name is fine if it is free, or if it already
 * holds a version of ours — otherwise the release stops before it has published anything.
 *
 *   OWNER=<crates.io user/team>  optional; when set, a taken name owned by OWNER passes
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UA = "forgegraph-release-check (https://github.com/gmackie/forgec)";
const owner = process.env["OWNER"] ?? "";

const workspace = readFileSync("Cargo.toml", "utf8");
const version = /^version\s*=\s*"([^"]+)"/m.exec(workspace.split("[workspace.package]")[1] ?? "")?.[1] ?? "";

const crates = readdirSync("crates", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const toml = readFileSync(join("crates", d.name, "Cargo.toml"), "utf8");
    return {
      dir: d.name,
      name: /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? d.name,
      publish: !/^publish\s*=\s*false/m.test(toml),
    };
  })
  .filter((c) => c.publish);

let failed = false;
for (const c of crates) {
  let res;
  try {
    res = await fetch(`https://crates.io/api/v1/crates/${c.name}`, { headers: { "user-agent": UA } });
  } catch (e) {
    console.error(`::warning::could not reach crates.io for ${c.name}: ${String(e)}`);
    continue;
  }
  if (res.status === 404) {
    console.error(`${c.name}: free`);
    continue;
  }
  if (!res.ok) {
    console.error(`::warning::crates.io answered ${res.status} for ${c.name}; not checked`);
    continue;
  }
  const body = await res.json();
  const owners = [body.crate?.["id"], ...(body.versions ?? []).map((v) => v.published_by?.login).filter(Boolean)];
  const mine = owner && owners.includes(owner);
  const alreadyOurs = (body.versions ?? []).some((v) => v.num === version);
  if (mine || alreadyOurs) {
    console.error(`${c.name}: ours (latest ${body.crate?.max_version})`);
    continue;
  }
  console.error(
    `::error::crate name "${c.name}" (crates/${c.dir}) is taken on crates.io at ${body.crate?.max_version} — ` +
      `"${(body.crate?.description ?? "").slice(0, 80)}". Rename the crate before releasing: a publish that ` +
      `reaches this one has already published every crate before it, permanently.`,
  );
  failed = true;
}
process.exit(failed ? 1 : 0);
