// The file-map request for an app: the tracked files of the app and its path dependencies, plus what
// sealing reads outside them (pnpm-lock.yaml, linked package.json files, the tsconfig it extends,
// pinned extension manifests). A caller such as Loom sends the files of its Session snapshot instead.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dirname, "../../..");

export const ACME = {
  root: "examples/acme",
  dirs: ["examples/acme", "examples/payments"],
  extra: [
    "pnpm-lock.yaml",
    "packages/runtime/package.json",
    "tsconfig.base.json",
    "packages/contracts/capability-manifest/manifests/d1.json",
    "packages/contracts/capability-manifest/manifests/dynamodb.json",
  ],
};

/** Tracked (committed or staged) files, as git would hand them to a Session. */
export function fileMap({ dirs, extra }, cwd = repoRoot) {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...dirs], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = {};
  for (const p of [...new Set([...tracked, ...extra])].sort()) files[p] = readFileSync(join(cwd, p), "utf8");
  return files;
}

export function acmeRequest(extra = {}) {
  return { root: ACME.root, source: { files: fileMap(ACME) }, ...extra };
}
