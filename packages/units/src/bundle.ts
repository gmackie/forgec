// One ESM module per js-module unit: the unit's own impl code and whatever local code it imports,
// with the shared libraries (the runtime and Effect) left as imports the linker provides. The
// module's default export is the unit body. esbuild is the bundler the deploy scripts already use.
// This is the native bundler, over a checkout on disk; memory.ts bundles a snapshot the same way.
import { build, version as esbuildVersion } from "esbuild";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { unitBuildOptions, unitModule, type UnitModule } from "./bundle-core.ts";
import { nodeFiles } from "./files.ts";
import type { ImplSite } from "./locate.ts";

export { libraryOf, SHARED_LIBRARIES, type Finding, type UnitModule } from "./bundle-core.ts";

export const BUNDLER = `esbuild@${esbuildVersion}`;

export function libraryVersion(appRoot: string, name: string): string {
  for (let dir = appRoot; ; dir = dirname(dir)) {
    const pkg = join(dir, "node_modules", name, "package.json");
    if (existsSync(pkg)) return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
    if (dirname(dir) === dir) throw new Error(`shared library ${name} is not installed under ${appRoot}`);
  }
}

export async function bundleUnit(app: string, site: ImplSite): Promise<UnitModule> {
  // esbuild reports inputs by real path; a symlinked root (macOS /var, worktrees) must match it
  // or input names turn into `../` paths that leak the build machine's layout.
  const appRoot = realpathSync(app);
  const result = await build(unitBuildOptions(appRoot, site));
  return unitModule(site, result, nodeFiles(appRoot), (lib) => libraryVersion(appRoot, lib));
}
