// FORG-50: sealing over a snapshot in memory gives the bytes the native sealer writes from a
// checkout. The snapshot is the repository's tracked files, read with no node_modules; the shared
// libraries come from pnpm-lock.yaml. Native esbuild and esbuild-wasm both run the memory host.
import * as native from "esbuild";
import * as wasm from "esbuild-wasm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lockedLibraries, memoryFiles, memoryHost, seal, sealWith, SHARED_LIBRARIES, stableJson, type Sealed, type UnitPlan } from "../src/index.ts";

const root = resolve(import.meta.dirname, "../../..");
const forgec = join(root, "target/debug/forgec");
const out = mkdtempSync(join(tmpdir(), "forge-units-memory-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Tracked files under `dirs`, plus `extra`, keyed by repository-relative path. */
function snapshot(dirs: string[], extra: string[]): Map<string, Uint8Array> {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...dirs], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  return new Map([...tracked, ...extra].sort().map((p) => [p, new Uint8Array(readFileSync(join(root, p)))]));
}

const bytes = (s: Sealed) => [stableJson(s.manifest), ...[...s.modules].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}\n${Buffer.from(v).toString("base64")}`)];

describe("sealing examples/acme from memory", async () => {
  execFileSync(forgec, ["build", join(root, "examples/acme"), "--units", "--out", out], { stdio: "pipe" });
  const plan = JSON.parse(readFileSync(join(out, "units/plan.json"), "utf8")) as UnitPlan;
  const disk = await seal(plan, join(root, "examples/acme"));
  const files = snapshot(["examples/acme", "examples/payments"], ["pnpm-lock.yaml", "packages/runtime/package.json", "tsconfig.base.json"]);
  const read = (p: string) => files.get(p);
  const libraries = lockedLibraries(new TextDecoder().decode(files.get("pnpm-lock.yaml")), "examples/acme", SHARED_LIBRARIES, read);

  it("reads the shared libraries' versions from pnpm-lock.yaml as node_modules has them", () => {
    const installed = (name: string) => (JSON.parse(readFileSync(join(root, "examples/acme/node_modules", name, "package.json"), "utf8")) as { version: string }).version;
    expect(libraries).toEqual(Object.fromEntries(SHARED_LIBRARIES.map((n) => [n, installed(n)])));
  });

  it("is byte-identical to the native sealer with native esbuild", async () => {
    const mem = await sealWith(plan, memoryHost({ files: memoryFiles(files, "examples/acme"), appRoot: "examples/acme", esbuild: native, libraries }));
    expect(bytes(mem)).toEqual(bytes(disk));
  });

  it("is byte-identical to the native sealer with esbuild-wasm, the Worker's bundler", async () => {
    expect(wasm.version).toBe(native.version);
    const mem = await sealWith(plan, memoryHost({ files: memoryFiles(files, "examples/acme"), appRoot: "examples/acme", esbuild: wasm, libraries }));
    expect(mem.manifest.manifestHash).toBe(disk.manifest.manifestHash);
    expect(bytes(mem)).toEqual(bytes(disk));
  });

  it("asks ensure for every file the bundler resolves, so a remote host can fetch it first", async () => {
    const asked = new Set<string>();
    const host = memoryHost({ files: memoryFiles(files, "examples/acme"), appRoot: "examples/acme", esbuild: native, libraries, ensure: async (p) => void asked.add(p) });
    expect(bytes(await sealWith(plan, host))).toEqual(bytes(disk));
    expect([...asked].filter((p) => files.has(join("examples/acme", p))).sort()).toEqual(["impl/fulfill-order.ts", "impl/payment-adapter.ts", "impl/rebuild-order-summary.ts", "impl/submit-order.ts"]);
  });

  it("refuses a bare import that is not a shared library: there is no node_modules", async () => {
    const edited = new Map(files);
    const path = "examples/acme/impl/submit-order.ts";
    edited.set(path, new TextEncoder().encode(`import "left-pad";\n${new TextDecoder().decode(files.get(path))}`));
    await expect(sealWith(plan, memoryHost({ files: memoryFiles(edited, "examples/acme"), appRoot: "examples/acme", esbuild: native, libraries }))).rejects.toThrow(/left-pad/);
  });
});
