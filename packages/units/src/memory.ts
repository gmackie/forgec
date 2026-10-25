// Sealing over a snapshot in memory (FORG-50): the build service runs this in a Worker, where there
// is no filesystem, no node_modules and no native esbuild. The caller passes the files (a map, or a
// view over a remote tree), an esbuild with the native one's API (esbuild-wasm in a Worker) and
// the shared libraries' versions. A plugin answers esbuild's file lookups from the snapshot, so the
// bundle is the one the native bundler writes from the same files (test/memory.test.ts).
import type { Plugin } from "esbuild";
import ts from "typescript";
import { unitBuildOptions, unitModule } from "./bundle-core.ts";
import { dirname, join, normalize, relative, text, type SourceFiles } from "./files.ts";
import type { SealHost } from "./sealer.ts";

/** The part of esbuild's API the bundler uses: native esbuild and esbuild-wasm both provide it. */
export interface Esbuild {
  build: typeof import("esbuild").build;
  version: string;
}

export interface MemoryHostOptions {
  files: SourceFiles;
  /** The app root, repository-relative (`examples/acme`). Bundles name their sources relative to it. */
  appRoot: string;
  esbuild: Esbuild;
  /** Installed versions of the shared libraries: see `lockedLibraries`. */
  libraries: Record<string, string>;
  /**
   * Called before a file the bundler wants is read, so a host over a remote tree can fetch it
   * first. A host whose snapshot is complete leaves it out.
   */
  ensure?: (path: string) => Promise<void>;
}

// esbuild's own lookup order for a relative import: the path itself, then each resolve extension,
// then TypeScript's `.js`-means-`.ts` rewrite, then a directory's index file.
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];
const REWRITES: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx" | "json" | "css" | "text"> = {
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".json": "json", ".css": "css", ".txt": "text",
};
const extname = (path: string) => /\.[^./]+$/.exec(path)?.[0] ?? "";

function candidates(path: string): string[] {
  const out = [path, ...EXTENSIONS.map((e) => path + e)];
  const ext = extname(path);
  for (const r of REWRITES[ext] ?? []) out.push(path.slice(0, -ext.length) + r);
  out.push(...EXTENSIONS.map((e) => `${path}/index${e}`));
  return out;
}

/** The compiler options esbuild would take from the app's tsconfig.json, `extends` (relative) followed. */
function tsconfigOf(files: SourceFiles): { compilerOptions: Record<string, unknown> } | undefined {
  const chain: Array<Record<string, unknown>> = [];
  for (let path: string | undefined = "tsconfig.json", seen = 0; path && seen < 16; seen++) {
    const bytes = files.read(path);
    if (!bytes) break;
    const parsed = ts.parseConfigFileTextToJson(path, text(bytes));
    if (parsed.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
    const config = parsed.config as { extends?: unknown; compilerOptions?: Record<string, unknown> };
    chain.unshift(config.compilerOptions ?? {});
    const next = typeof config.extends === "string" && config.extends.startsWith(".") ? config.extends : undefined;
    path = next ? join(dirname(path), next.endsWith(".json") ? next : `${next}.json`) : undefined;
  }
  return chain.length ? { compilerOptions: Object.assign({}, ...chain) } : undefined;
}

export function memoryHost(options: MemoryHostOptions): SealHost {
  const { files, esbuild, libraries, ensure } = options;
  // A virtual absolute root with the app's own depth, so `../payments/...` stays inside it.
  const root = `/${normalize(options.appRoot)}`;
  const toApp = (abs: string) => relative(root, abs);
  const tsconfigRaw = tsconfigOf(files);
  const has = async (abs: string) => {
    const path = toApp(abs);
    await ensure?.(path);
    return files.read(path) !== undefined;
  };
  const plugin: Plugin = {
    name: "forge-snapshot",
    setup(b) {
      b.onResolve({ filter: /^(\.\.?(\/|$)|\/)/ }, async (args) => {
        const base = normalize(args.path.startsWith("/") ? args.path : join(args.resolveDir || root, args.path));
        for (const c of candidates(base)) if (await has(c)) return { path: c, namespace: "file" };
        return { errors: [{ text: `Could not resolve "${args.path}" in the source snapshot` }] };
      });
      b.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        const path = toApp(args.path);
        await ensure?.(path);
        const bytes = files.read(path);
        if (!bytes) return { errors: [{ text: `${path} is not in the source snapshot` }] };
        return { contents: bytes, loader: LOADERS[extname(path)] ?? "js", resolveDir: dirname(args.path) };
      });
    },
  };
  const libraryVersion = (name: string) => {
    const v = libraries[name];
    if (!v) throw new Error(`shared library ${name} is not installed under ${options.appRoot}`);
    return v;
  };
  return {
    files,
    label: options.appRoot,
    bundler: `esbuild@${esbuild.version}`,
    libraryVersion,
    async bundle(site) {
      const result = await esbuild.build({ ...unitBuildOptions(root, site), ...(tsconfigRaw ? { tsconfigRaw } : {}), plugins: [plugin] });
      return unitModule(site, result, files, libraryVersion);
    },
  };
}

/**
 * The versions a frozen `pnpm install` puts under node_modules, read from pnpm-lock.yaml: what
 * the native sealer finds by walking `node_modules/<name>/package.json` up from the app. The app's
 * importer is searched first, then each enclosing directory's. A `link:` version (a workspace
 * package) is that package's package.json version, read through `read` (repository-relative).
 */
export function lockedLibraries(lock: string, appRoot: string, names: string[], read: (path: string) => Uint8Array | undefined): Record<string, string> {
  const importers = parseImporters(lock);
  const out: Record<string, string> = {};
  for (const name of names) {
    for (let dir = normalize(appRoot); ; dir = dirname(dir)) {
      const version = importers.get(dir)?.get(name);
      if (version) {
        if (version.startsWith("link:")) {
          const pkg = join(dir, version.slice("link:".length), "package.json");
          const bytes = read(pkg);
          if (!bytes) throw new Error(`pnpm-lock.yaml links ${name} to ${pkg}, which is not in the snapshot`);
          out[name] = (JSON.parse(text(bytes)) as { version: string }).version;
        } else out[name] = version.replace(/\(.*$/, "");
        break;
      }
      if (dir === "." || dir === "/") break;
    }
  }
  return out;
}

/** `importers.<dir>.{dependencies,devDependencies,optionalDependencies}.<name>.version` from a v9 lockfile. */
function parseImporters(lock: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let inImporters = false;
  let importer: Map<string, string> | undefined;
  let group = false;
  let dep: string | undefined;
  const unquote = (s: string) => s.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  for (const line of lock.split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line.startsWith("importers:");
      importer = undefined;
      continue;
    }
    if (!inImporters || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 2) {
      importer = new Map();
      out.set(normalize(unquote(body.replace(/:$/, ""))), importer);
    } else if (indent === 4) {
      group = /^(dependencies|devDependencies|optionalDependencies):$/.test(body);
    } else if (indent === 6 && group) {
      dep = unquote(body.replace(/:$/, ""));
    } else if (indent === 8 && group && dep && importer && body.startsWith("version:")) {
      importer.set(dep, unquote(body.slice("version:".length).trim()));
    }
  }
  return out;
}
