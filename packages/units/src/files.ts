// The app's files as the sealer reads them (FORG-50): app-relative, `/`-separated paths, so the
// same sealing code runs over a checkout on disk (`nodeFiles`) or over a snapshot held in memory
// (`memoryFiles`, the build service in a Worker). Paths may leave the app root (`../payments/...`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface SourceFiles {
  /** The bytes of a file, or undefined when there is no such file. */
  read(path: string): Uint8Array | undefined;
  /** Every file under `dir`, recursively, as paths in the same form as `dir`'s; [] when there is none. */
  list(dir: string): string[];
}

/** Lexical `/` normalization: `.` dropped, `..` folded where it can be, no trailing slash. */
export function normalize(path: string): string {
  const out: string[] = [];
  const absolute = path.startsWith("/");
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !absolute) out.push(part);
  }
  return (absolute ? "/" : "") + out.join("/") || (absolute ? "/" : ".");
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== "").join("/"));
}

export function dirname(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "." : at === 0 ? "/" : path.slice(0, at);
}

/** `to` relative to `from`, both normalized and both relative (or both absolute). */
export function relative(from: string, to: string): string {
  const a = from === "." ? [] : normalize(from).split("/").filter(Boolean);
  const b = to === "." ? [] : normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/** A checkout on disk. Relative paths resolve against `appRoot`, exactly as `resolve(appRoot, path)`. */
export function nodeFiles(appRoot: string): SourceFiles {
  const abs = (path: string) => resolve(appRoot, path);
  return {
    read(path) {
      try {
        return new Uint8Array(readFileSync(abs(path)));
      } catch {
        return undefined;
      }
    },
    list(dir) {
      const walk = (rel: string): string[] => {
        try {
          return readdirSync(abs(rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${rel}/${d.name}`) : [`${rel}/${d.name}`]));
        } catch {
          return [];
        }
      };
      return statSync(abs(dir), { throwIfNoEntry: false })?.isDirectory() ? walk(dir).map(normalize).sort() : [];
    },
  };
}

/**
 * Files keyed by repository-relative path, viewed from the app at `appRoot` (also repository-relative,
 * e.g. `examples/acme`).
 */
export function memoryFiles(files: ReadonlyMap<string, Uint8Array>, appRoot: string): SourceFiles {
  const root = normalize(appRoot);
  const repoPath = (path: string) => join(root, path);
  return {
    read: (path) => files.get(repoPath(path)),
    list(dir) {
      const prefix = `${repoPath(dir)}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => relative(root, k))
        .sort();
    },
  };
}

/** UTF-8 text as `readFileSync(path, "utf8")` returns it: a byte order mark is kept. */
export function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
