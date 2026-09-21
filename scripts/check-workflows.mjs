#!/usr/bin/env node
/**
 * Parse every workflow file and reject the mistakes GitHub only reports *after*
 * you push — as a run named after the file path that failed before any job
 * started, with no log to read.
 *
 * The one that actually bit us: an unquoted `${{ ... }}` inside a flow mapping
 * (`with: { token: ${{ secrets.X }} }`). The `{` closes the mapping as far as
 * YAML is concerned, so the whole file is invalid and even `name:` is lost.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = ".github/workflows";
if (!existsSync(dir)) {
  console.error(`${dir} does not exist`);
  process.exit(0);
}

let failed = false;
const fail = (file, line, msg) => {
  console.error(`::error file=${file},line=${line}::${msg}`);
  failed = true;
};

for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  const file = join(dir, name);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, i) => {
    // A flow mapping on this line, with an expression inside it that is not quoted.
    if (!text.includes("${{")) return;
    const flow = /[:-]\s*\{.*\}/.test(text) || /\{[^}]*\$\{\{/.test(text);
    if (!flow) return;
    for (const m of text.matchAll(/\$\{\{[^}]*\}\}/g)) {
      const before = text.slice(0, m.index);
      const quotes = (before.match(/"/g) ?? []).length + (before.match(/'/g) ?? []).length;
      if (quotes % 2 === 0) {
        fail(file, i + 1, `unquoted \${{ }} inside a flow mapping: YAML reads its "{" as opening a map, which invalidates the whole file. Quote it: { key: "\${{ ... }}" }`);
      }
    }
  });
}

// The parse itself, via the same library Actions uses in spirit: js-yaml if present, else node's own check.
const { load } = await import("js-yaml").catch(() => ({ load: null }));
if (load) {
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const file = join(dir, name);
    try {
      const doc = load(readFileSync(file, "utf8"));
      if (!doc || typeof doc !== "object") fail(file, 1, "does not parse to a mapping");
      else if (!("jobs" in doc)) fail(file, 1, "has no `jobs` key");
      else console.error(`${file}: ok (${Object.keys(doc.jobs).length} jobs)`);
    } catch (e) {
      fail(file, 1, `does not parse: ${e.message.split("\n")[0]}`);
    }
  }
} else {
  console.error("js-yaml is not installed; ran the flow-mapping check only");
}

process.exit(failed ? 1 : 0);
