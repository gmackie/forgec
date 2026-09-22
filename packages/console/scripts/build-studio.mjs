import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../..");
const source = resolve(root, "packages/console/studio");
const out = resolve(root, "packages/console/generated/studio");
const args = ["build", source, "--out", out];
if (process.env.FORGE_COMPILER)
  execFileSync(process.env.FORGE_COMPILER, args, { stdio: "inherit" });
else
  execFileSync(
    "cargo",
    ["run", "-p", "forgegraph-cli", "--bin", "forgec", "--", ...args],
    { cwd: root, stdio: "inherit" },
  );
const check = process.argv.includes("--check");
for (const [from, to] of [
  ["app.json", "studio/compiled/app.json"],
  ["d1/0001_init.sql", "migrations/0003_studio.sql"],
]) {
  const target = resolve(root, "packages/console", to),
    generated = readFileSync(resolve(out, from));
  if (check) {
    if (!generated.equals(readFileSync(target)))
      throw new Error(to + " is out of date; run studio:generate");
  } else writeFileSync(target, generated);
}
