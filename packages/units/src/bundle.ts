// One ESM module per js-module unit: the unit's own impl code and whatever local code it imports,
// with the shared libraries (the runtime and Effect) left as imports the linker provides. The
// module's default export is the unit body. esbuild is the bundler the deploy scripts already use.
import { build, version as esbuildVersion } from "esbuild";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImplSite } from "./locate.ts";

/** Libraries a host provides to every unit instead of each module carrying a copy. */
export const SHARED_LIBRARIES = ["effect", "@forgegraph/runtime"];

export const BUNDLER = `esbuild@${esbuildVersion}`;

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

export function libraryVersion(appRoot: string, name: string): string {
  for (let dir = appRoot; ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", name, "package.json");
    if (existsSync(pkg)) return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
    if (dirname(dir) === dir) throw new Error(`shared library ${name} is not installed under ${appRoot}`);
  }
}

export function libraryOf(spec: string): string | undefined {
  return SHARED_LIBRARIES.find((l) => spec === l || spec.startsWith(`${l}/`));
}

export async function bundleUnit(app: string, site: ImplSite): Promise<UnitModule> {
  // esbuild reports inputs by real path; a symlinked root (macOS /var, worktrees) must match it
  // or input names turn into `../` paths that leak the build machine's layout.
  const appRoot = realpathSync(app);
  const result = await build({
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
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error(`${site.symbol}: esbuild produced no output`);
  const meta = Object.values(result.metafile.outputs)[0]!;
  const sources = Object.keys(meta.inputs).filter((s) => s !== "unit-entry.ts").sort();
  const libraries: Record<string, string> = {};
  for (const i of meta.imports) {
    const lib = i.external ? libraryOf(i.path) : undefined;
    if (lib) libraries[lib] = libraryVersion(appRoot, lib);
  }
  const findings: Finding[] = [];
  for (const source of sources) {
    const text = readFileSync(join(appRoot, source), "utf8");
    for (const [rule, re] of RULES) for (const m of text.matchAll(re)) findings.push({ rule, match: m[0], source });
  }
  const key = (f: Finding) => `${f.source}\0${f.rule}\0${f.match}`;
  const unique = [...new Map(findings.map((f) => [key(f), f])).values()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return { code: out.contents, sources, libraries, findings: unique };
}
