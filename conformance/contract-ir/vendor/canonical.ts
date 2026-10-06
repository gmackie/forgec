// Vendored verbatim from ForgeGraph packages/contract/src/canonical.ts
// at commit 0e6be228bf8771d81155bad3b4981c59a9df4620 (git.forgegraf.com/gmackie/forgegraph).
// Do not edit; refresh with conformance/contract-ir/vendor.sh.
import { createHash } from "node:crypto";

/**
 * JSON-compatible value. The IR is plain JSON so it can cross any boundary
 * (build step → CI → ForgeGraph server) without a runtime dependency.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, arrays
 * kept in order. Two structurally equal values always serialize identically,
 * so a hash of the output is a stable fingerprint.
 */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const inner = value[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}

/** `sha256:<hex>` of the canonical JSON form of `value`. */
export function fingerprint(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
