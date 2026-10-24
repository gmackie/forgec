// Digests shared with forgec (crates/forgegraph-planner/src/units.rs): `sha256:` + hex(sha256(domain +
// canonical JSON)), canonical JSON = object keys sorted, no whitespace, arrays in order.
import { createHash } from "node:crypto";

export const UNIT_DOMAIN = "forge:unit:";
export const IMPLEMENTATION_DOMAIN = "forge:unit-impl:";
export const CLOSURE_DOMAIN = "forge:closure:";
export const MANIFEST_DOMAIN = "forge:closure-manifest:";

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

export function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function digest(domain: string, value: unknown): string {
  return sha256(domain + JSON.stringify(canonical(value)));
}

/** Pretty, key-sorted JSON with a trailing newline: the on-disk form of every sealed artifact. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}
