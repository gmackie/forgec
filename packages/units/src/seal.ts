// `seal` over a checkout on disk: the host for sealer.ts that reads with node:fs, bundles with native
// esbuild, finds shared libraries under node_modules and verifies WASM components with jco.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLER, bundleUnit, libraryVersion } from "./bundle.ts";
import { nodeFiles } from "./files.ts";
import { stableJson } from "./hash.ts";
import { sealWith, type Sealed, type SealHost, type SealOptions, type UnitPlan } from "./sealer.ts";
import { TRANSPILER, verifyComponent } from "./wasm.ts";

export * from "./sealer.ts";

export function nodeHost(appRoot: string): SealHost {
  return {
    files: nodeFiles(appRoot),
    label: appRoot,
    bundler: BUNDLER,
    bundle: (site) => bundleUnit(appRoot, site),
    libraryVersion: (name) => libraryVersion(appRoot, name),
    components: { transpiler: TRANSPILER, verify: verifyComponent },
  };
}

export async function seal(plan: UnitPlan, appRoot: string, options: SealOptions = {}): Promise<Sealed> {
  return sealWith(plan, nodeHost(appRoot), options);
}

/** Writes `manifest.json` and `modules/<sha256>.{js,wasm}`, replacing any previous modules. */
export function writeSealed(sealed: Sealed, outDir: string): void {
  rmSync(join(outDir, "modules"), { recursive: true, force: true });
  mkdirSync(join(outDir, "modules"), { recursive: true });
  for (const [blob, code] of sealed.modules) writeFileSync(join(outDir, sealed.manifest.modules[blob]!.path), code);
  writeFileSync(join(outDir, "manifest.json"), stableJson(sealed.manifest));
}
