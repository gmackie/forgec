// What a unit's bundle is, independent of which esbuild builds it (FORG-50): the build options, and
// how a build result becomes a `UnitModule`. The native bundler (bundle.ts) and the in-memory one
// (memory.ts, esbuild-wasm in a Worker) share both, so they agree byte for byte.
import type { BuildOptions, BuildResult } from "esbuild";
import { text, type SourceFiles } from "./files.ts";
import type { ImplSite } from "./locate.ts";

/** Libraries a host provides to every unit instead of each module carrying a copy. */
export const SHARED_LIBRARIES = ["effect", "@forgegraph/runtime"];

export interface Finding {
  rule: "raw-env" | "raw-network" | "platform-module" | "nondeterminism" | "clock" | "global-scope";
  match: string;
  source: string;
}

export interface UnitModule {
  code: Uint8Array;
  sources: string[];
  libraries: Record<string, string>;
  findings: Finding[];
}

// Authority that bypasses capability handles. A text scan, so it can over- and under-report;
// findings are evidence for review, not a sandbox.
const RULES: Array<[Finding["rule"], RegExp]> = [
  ["raw-env", /\bprocess\.env\b|\benv\.[A-Z][A-Z0-9_]*\b|\benv\[["'`]/g],
  ["raw-network", /\bfetch\s*\(|\bnew\s+WebSocket\s*\(|\bconnect\s*\(\s*\{/g],
  ["platform-module", /\bfrom\s+["'](?:cloudflare:[\w-]+|node:[\w/-]+|@aws-sdk\/[\w-]+)["']/g],
  ["nondeterminism", /\bMath\.random\s*\(|\bcrypto\.randomUUID\s*\(|\bcrypto\.getRandomValues\s*\(/g],
  ["clock", /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(/g],
  ["global-scope", /\bglobalThis\b/g],
];

export function libraryOf(spec: string): string | undefined {
  return SHARED_LIBRARIES.find((l) => spec === l || spec.startsWith(`${l}/`));
}

/** The esbuild options for one unit, built from the app root `appRoot` (absolute, real or virtual). */
export function unitBuildOptions(appRoot: string, site: ImplSite) {
  return {
    stdin: { contents: `export { ${site.exportName} as default } from ${JSON.stringify(`./${site.file}`)};\n`, resolveDir: appRoot, sourcefile: "unit-entry.ts", loader: "ts" },
    absWorkingDir: appRoot,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    external: SHARED_LIBRARIES.flatMap((l) => [l, `${l}/*`]),
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  } satisfies BuildOptions;
}

/** A build result as a `UnitModule`: its sources (app-relative), the shared libraries it imports, its findings. */
export function unitModule(site: ImplSite, result: BuildResult<{ write: false; metafile: true }>, files: SourceFiles, libraryVersion: (name: string) => string): UnitModule {
  const out = result.outputFiles[0];
  if (!out) throw new Error(`${site.symbol}: esbuild produced no output`);
  const meta = Object.values(result.metafile.outputs)[0]!;
  const sources = Object.keys(meta.inputs).filter((s) => s !== "unit-entry.ts").sort();
  const libraries: Record<string, string> = {};
  for (const i of meta.imports) {
    const lib = i.external ? libraryOf(i.path) : undefined;
    if (lib) libraries[lib] = libraryVersion(lib);
  }
  const findings: Finding[] = [];
  for (const source of sources) {
    const bytes = files.read(source);
    if (!bytes) throw new Error(`${site.symbol}: bundled source ${source} is not readable`);
    const body = text(bytes);
    for (const [rule, re] of RULES) for (const m of body.matchAll(re)) findings.push({ rule, match: m[0], source });
  }
  const key = (f: Finding) => `${f.source}\0${f.rule}\0${f.match}`;
  const unique = [...new Map(findings.map((f) => [key(f), f])).values()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return { code: out.contents, sources, libraries, findings: unique };
}
