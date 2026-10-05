/**
 * Capability manifests (plan §3.3, FORGE-030). An adapter, taxonomy or
 * importer publishes a declarative JSON manifest: identity, versions, the
 * capabilities it supports with `native` / `bounded-emulation` / `unsupported`
 * and the bound, assumptions and evidence references behind each claim. The
 * compiler resolves a profile's requirements against pinned manifests
 * offline and deterministically. Manifests carry no code and cannot
 * self-certify: `support` without an evidence reference is invalid.
 */
import { createHash } from "node:crypto";

export const MANIFEST_VERSION = "capability-manifest/1";
export type Support = "native" | "bounded-emulation" | "unsupported";
export type Resolution = Support | "unknown";

export interface Evidence { kind: "conformance-report" | "test" | "vendor-doc" | "attestation"; ref: string }
export interface CapabilityClaim {
  id: string;
  support: Support;
  /** Numeric bounds (e.g. `{ actions: 100, bytes: 1048576 }`); a requirement's bound must fit inside. */
  bound?: Record<string, number>;
  assumptions?: string[];
  evidence: Evidence[];
}
export interface CapabilityManifest {
  version: typeof MANIFEST_VERSION;
  id: string;
  kind: "adapter" | "taxonomy" | "importer";
  adapterVersion: string;
  engine: { name: string; version: string };
  runtime: { name: string; version: string };
  isolation?: string[];
  consistency?: string[];
  capabilities: CapabilityClaim[];
}
export interface Requirement { id: string; bound?: Record<string, number> }
export interface Resolved { support: Resolution; bound?: Record<string, number>; assumptions?: string[]; evidence?: Evidence[]; reason?: string }
export interface AdapterResolution { adapter: string; digest: string; resolutions: Record<string, Resolved>; satisfied: boolean; unsatisfied: string[] }

const FORBIDDEN_KEYS = ["main", "exports", "scripts", "bin", "module", "require", "install", "postinstall", "code", "script"];

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}
export function digestOf(m: CapabilityManifest): string {
  return createHash("sha256").update("forge:capability-manifest:" + JSON.stringify(canonical(m))).digest("hex");
}

export function validateManifest(m: CapabilityManifest): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!m || typeof m !== "object") return { ok: false, errors: ["manifest must be an object"] };
  const obj = m as unknown as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (FORBIDDEN_KEYS.includes(k)) errors.push(`executable/entry field \`${k}\` is not allowed: manifests declare, they never run (main)`);
  if (obj["version"] !== MANIFEST_VERSION) errors.push(`version must be ${MANIFEST_VERSION}`);
  if (typeof obj["id"] !== "string" || !/^@?[a-z0-9][a-z0-9/_.-]*$/i.test(obj["id"] as string)) errors.push("id must be a package-style identifier");
  if (!["adapter", "taxonomy", "importer"].includes(String(obj["kind"]))) errors.push("kind must be adapter | taxonomy | importer");
  if (typeof obj["adapterVersion"] !== "string") errors.push("adapterVersion is required");
  for (const k of ["engine", "runtime"]) {
    const v = obj[k] as { name?: unknown; version?: unknown } | undefined;
    if (!v || typeof v.name !== "string" || typeof v.version !== "string") errors.push(`${k} must give name and version (a brand name is not evidence of parity)`);
  }
  const caps = obj["capabilities"];
  if (!Array.isArray(caps) || caps.length === 0) errors.push("capabilities must be a non-empty array");
  else {
    const seen = new Set<string>();
    for (const c of caps as CapabilityClaim[]) {
      if (typeof c.id !== "string") { errors.push("capability id is required"); continue; }
      if (seen.has(c.id)) errors.push(`duplicate capability ${c.id}`);
      seen.add(c.id);
      if (!["native", "bounded-emulation", "unsupported"].includes(c.support)) errors.push(`${c.id}: support must be native | bounded-emulation | unsupported`);
      if (c.support !== "unsupported" && (!Array.isArray(c.evidence) || c.evidence.length === 0 || c.evidence.some((e) => !e || typeof e !== "object" || typeof e.ref !== "string"))) errors.push(`${c.id}: a supported capability needs evidence references (no self-certification)`);
      if (c.support === "bounded-emulation" && (!c.assumptions || c.assumptions.length === 0)) errors.push(`${c.id}: bounded emulation must state its assumptions`);
      if (c.bound && Object.values(c.bound).some((n) => typeof n !== "number" || !(n >= 0))) errors.push(`${c.id}: bounds must be non-negative numbers`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Resolve requirements against manifests: sorted output, no clamping, unknown stays unknown. */
export function resolveRequirements(requirements: Requirement[], manifests: CapabilityManifest[]): AdapterResolution[] {
  const reqs = [...requirements].sort((a, b) => a.id.localeCompare(b.id));
  return [...manifests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const resolutions: Record<string, Resolved> = {};
      const unsatisfied: string[] = [];
      for (const r of reqs) {
        const claim = m.capabilities.find((c) => c.id === r.id);
        let res: Resolved;
        if (!claim) res = { support: "unknown", reason: "manifest makes no claim; treat as unsupported until evidenced" };
        else if (claim.support === "unsupported") res = { support: "unsupported", ...(claim.assumptions ? { assumptions: claim.assumptions } : {}) };
        else {
          const tooTight = Object.entries(r.bound ?? {}).find(([k, v]) => claim.bound?.[k] !== undefined && v > claim.bound[k]!);
          res = tooTight
            ? { support: "unsupported", reason: `requirement ${r.id}.${tooTight[0]}=${tooTight[1]} exceeds the adapter bound ${claim.bound![tooTight[0]]}`, ...(claim.bound ? { bound: claim.bound } : {}) }
            : { support: claim.support, ...(claim.bound ? { bound: claim.bound } : {}), ...(claim.assumptions ? { assumptions: claim.assumptions } : {}), evidence: claim.evidence };
        }
        resolutions[r.id] = res;
        if (res.support === "unsupported" || res.support === "unknown") unsatisfied.push(r.id);
      }
      return { adapter: m.id, digest: digestOf(m), resolutions, satisfied: unsatisfied.length === 0, unsatisfied };
    });
}

export * from "./execution.js";
