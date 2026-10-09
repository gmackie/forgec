import type { OpenApiImport } from "./editor/language.js";
import { safeZipPath, type ZipFile } from "./zip-store.js";

export interface ForgePackage {
  files?: ZipFile[];
  error?: string;
}

/**
 * Turn the browser importer's result into the files `forgec check` opens.
 * The wasm export returns `.forge` sources. The manifest matches
 * `forgegraph-codegen`'s OpenAPI importer, which writes edition 2026 and
 * `src/index.forge`. An importer that already returned `forge.toml` or
 * `import-report.json` keeps those bytes.
 */
export function forgePackage(packageName: string, imported: OpenApiImport): ForgePackage {
  if (imported.error) return { error: imported.error };
  const incoming = imported.files ?? [];
  for (const file of incoming) {
    if (!safeZipPath(file.path)) return { error: `Refusing package path ${file.path}` };
  }
  const sources = incoming.filter((file) => file.path.endsWith(".forge"));
  if (!sources.length) return { error: "This document did not produce a Forge package." };
  const files: ZipFile[] = [];
  files.push(incoming.find((file) => file.path === "forge.toml") ?? { path: "forge.toml", text: forgeManifest(packageName, imported.report?.source.version || "0.0.0") });
  files.push(...sources);
  const foreign = incoming.find((file) => file.path === "FOREIGN_IDS.md");
  if (foreign) files.push(foreign);
  files.push(
    incoming.find((file) => file.path === "import-report.json") ?? {
      path: "import-report.json",
      text: `${JSON.stringify(imported.report ?? {}, null, 2)}\n`,
    },
  );
  return { files };
}

function tomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "");
}

/** Manifest written by the OpenAPI importer in forgegraph-codegen. */
export function forgeManifest(packageName: string, version: string): string {
  return `[package]\nname = "${tomlString(packageName)}"\nversion = "${tomlString(version)}"\nedition = "2026"\n\n[source]\nroot = "src"\nentry = "src/index.forge"\n\n[compatibility]\nprofile = "portable-v1"\ntargets = ["cloudflare-d1", "aws-dynamodb"]\n`;
}
