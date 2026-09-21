#!/usr/bin/env node
/** The CHANGELOG section for one version, verbatim. A release with no entry is a release nobody can read. */
import { readFileSync } from "node:fs";
const version = (process.argv[2] ?? "").replace(/^v/, "");
const text = readFileSync("CHANGELOG.md", "utf8");
const start = text.search(new RegExp(`^##\\s+\\[?${version.replace(/\./g, "\\.")}\\]?`, "m"));
if (start < 0) {
  console.error(`::error::CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const rest = text.slice(start);
const next = rest.slice(1).search(/^## /m);
const body = (next < 0 ? rest : rest.slice(0, next + 1)).trim();
console.log(body);
console.log(`\n---\n\nInstall the compiler:\n\n\`\`\`\nbrew install gmacko/tap/forgec        # macOS and Linux\ncargo install forgegraph-cli          # from source\n\`\`\`\n\nRuntime packages are on npm under \`@forgegraph/*\` with build provenance.\nCertified profiles and their evidence: \`RELEASE_MANIFEST.json\`.`);
