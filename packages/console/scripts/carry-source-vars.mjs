// The ForgeGraph agent stamps FG_COMMIT_HASH and its other FG_* vars into the first wrangler
// config it finds (wrangler.jsonc), but forge.gmac.io deploys with --config wrangler.gmac.jsonc.
// Without the hash on the serving version, the agent's source-order guard refuses every later
// deploy (FORG-52). The build therefore copies stamped FG_* vars into the deployment config,
// adding only keys it lacks. It is a no-op when nothing is stamped, as in local builds.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, "");

/** FG_* vars from a wrangler config's top-level "vars". */
export function stampedVars(text) {
  const vars = JSON.parse(stripComments(text)).vars ?? {};
  return Object.fromEntries(Object.entries(vars).filter(([key, value]) => key.startsWith("FG_") && typeof value === "string"));
}

/** Inserts `vars` absent from the target config's top-level "vars" object, keeping its text. */
export function carryVars(target, vars) {
  const present = JSON.parse(stripComments(target)).vars ?? {};
  const missing = Object.entries(vars).filter(([key]) => !(key in present));
  if (missing.length === 0) return target;
  const open = target.match(/^(\s*)"vars"\s*:\s*\{\n/m);
  if (!open) throw new Error('the deployment config has no top-level "vars" object to carry FG_* vars into');
  const indent = `${open[1]}  `;
  const lines = missing.map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value)},\n`).join("");
  const at = open.index + open[0].length;
  return target.slice(0, at) + lines + target.slice(at);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source = "wrangler.jsonc", target = "wrangler.gmac.jsonc"] = process.argv.slice(2);
  const vars = stampedVars(readFileSync(source, "utf8"));
  const before = readFileSync(target, "utf8");
  const after = carryVars(before, vars);
  if (after !== before) writeFileSync(target, after);
  console.log(`carry-source-vars: ${Object.keys(vars).length} stamped, ${after === before ? "nothing to add" : `added to ${target}`}`);
}
