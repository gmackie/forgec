// Loads a sealed Closure Manifest and refuses it unless every digest it states can be recomputed from
// what is on disk. Everything the linker later trusts (unit hashes, module bytes, closures) is checked
// here, so a broken manifest fails at link time and never reaches a request.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { digest, sha256, type ClosureManifest } from "@forgegraph/units";

export type Manifest = ClosureManifest;
export type ManifestEntryPoint = Manifest["entryPoints"][number];
export type ManifestUnit = Manifest["units"][string];

const CLOSURE_DOMAIN = "forge:closure:";
const MANIFEST_DOMAIN = "forge:closure-manifest:";

export type LinkErrorCode =
  | "manifest-hash"
  | "missing-module"
  | "module-hash"
  | "missing-unit"
  | "closure"
  | "closure-hash"
  | "undeclared-capability"
  | "unprovided-capability"
  | "undeclared-binding"
  | "slice";

/** A refusal at link time. `code` is stable so tests and callers can tell the reasons apart. */
export class LinkError extends Error {
  readonly code: LinkErrorCode;
  constructor(code: LinkErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LinkError";
    this.code = code;
  }
}

export interface LoadedManifest {
  manifest: Manifest;
  /** Module bytes by blob digest, each verified against its digest. */
  modules: Map<string, Uint8Array>;
}

/** Recomputes the manifest hash over the manifest without `manifestHash`, as the sealer does. */
export function manifestHashOf(m: Manifest): string {
  const { manifestHash: _, ...body } = m;
  return digest(MANIFEST_DOMAIN, body);
}

/**
 * Verifies a manifest read from `dir` (the sealer's output directory: `manifest.json` plus
 * `modules/<sha256>.js`). Pass `manifest` to verify an in-memory manifest against the same modules.
 */
export function loadManifest(dir: string, manifest?: Manifest): LoadedManifest {
  const m = manifest ?? (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest);
  if (m.version !== "closure-manifest/1") throw new LinkError("manifest-hash", `unsupported manifest version ${String(m.version)}`);
  const expected = manifestHashOf(m);
  if (m.manifestHash !== expected) throw new LinkError("manifest-hash", `manifest states ${m.manifestHash} but its content hashes to ${expected}`);

  const modules = new Map<string, Uint8Array>();
  for (const [blob, info] of Object.entries(m.modules)) {
    const path = join(dir, info.path);
    if (!existsSync(path)) throw new LinkError("missing-module", `module ${blob} is not at ${info.path}`);
    const bytes = new Uint8Array(readFileSync(path));
    if (sha256(bytes) !== blob) throw new LinkError("module-hash", `${info.path} hashes to ${sha256(bytes)}, not ${blob}`);
    modules.set(blob, bytes);
  }

  for (const [hash, u] of Object.entries(m.units)) {
    if (u.kind === "js-module") {
      const blob = u.implementation["module"] as string;
      if (!modules.has(blob)) throw new LinkError("missing-module", `${u.symbol} (${hash}) runs module ${blob}, which the manifest does not carry`);
    }
    for (const d of u.dependencies) if (!m.units[d]) throw new LinkError("missing-unit", `${u.symbol} depends on ${d}, which is not in the manifest`);
    for (const i of u.imports) if (i.provider.kind === "unit" && !m.units[i.provider.unit]) throw new LinkError("missing-unit", `${u.symbol} imports ${i.capability} from ${i.provider.unit}, which is not in the manifest`);
  }

  for (const e of m.entryPoints) {
    if (e.root && !m.units[e.root]) throw new LinkError("missing-unit", `entry point ${e.id}: root ${e.root} is not in the manifest`);
    for (const h of e.closure) if (!m.units[h]) throw new LinkError("missing-unit", `entry point ${e.id}: closure member ${h} is not in the manifest`);
    const reach = e.root ? closureOf(m, e.root) : [];
    if (JSON.stringify(reach) !== JSON.stringify(e.closure)) throw new LinkError("closure", `entry point ${e.id}: stated closure differs from the units reachable from its root`);
    const ch = digest(CLOSURE_DOMAIN, e.closure);
    if (ch !== e.closureHash) throw new LinkError("closure-hash", `entry point ${e.id}: closureHash ${e.closureHash} does not match ${ch}`);
    // A unit-provided import must be satisfied inside the closure: nothing outside it is linked in.
    for (const h of e.closure) {
      for (const i of m.units[h]!.imports) {
        if (i.provider.kind === "unit" && !e.closure.includes(i.provider.unit)) {
          throw new LinkError("unprovided-capability", `entry point ${e.id}: ${m.units[h]!.symbol} imports ${i.capability} from a unit outside the closure`);
        }
      }
    }
  }
  return { manifest: m, modules };
}

export function closureOf(m: Manifest, root: string): string[] {
  const seen = new Set<string>();
  const walk = (h: string) => {
    if (seen.has(h)) return;
    const u = m.units[h];
    if (!u) throw new LinkError("missing-unit", `${h} is not in the manifest`);
    seen.add(h);
    u.dependencies.forEach(walk);
  };
  walk(root);
  return [...seen].sort();
}

/** Re-seals a manifest after an edit (tests, and the edit measurement): recomputes closure hashes and the manifest hash. */
export function reseal(m: Manifest): Manifest {
  const entryPoints = m.entryPoints.map((e) => ({ ...e, closureHash: digest(CLOSURE_DOMAIN, e.closure) }));
  const next = { ...m, entryPoints };
  return { ...next, manifestHash: manifestHashOf(next) };
}
