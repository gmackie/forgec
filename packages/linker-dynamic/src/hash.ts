// The Closure Manifest's digests (packages/units/src/hash.ts), recomputed with WebCrypto so the
// host can verify a manifest inside workerd: `sha256:` + hex(sha256(domain + canonical JSON)).
export const CLOSURE_DOMAIN = "forge:closure:";
export const MANIFEST_DOMAIN = "forge:closure-manifest:";
export const LINK_DOMAIN = "forge:linker-dynamic:";

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

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256(bytes: string | Uint8Array): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>))}`;
}

export function digest(domain: string, value: unknown): Promise<string> {
  return sha256(domain + JSON.stringify(canonical(value)));
}
