/** In-memory object store with the same seal/staging semantics as R2/S3 (the semantic reference). */
import { Effect } from "effect";
import { err, type ForgeError } from "../errors.js";
import type { ObjectHead, ObjectStoreAdapter, SignedUrl } from "../services.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class MemoryObjectStore implements ObjectStoreAdapter {
  readonly name = "memory-objects";
  private objects = new Map<string, { bytes: Uint8Array; mediaType: string | null; generation: string }>();
  private gen = 0;

  presignUpload(key: string, mediaType: string, byteCount: number, ttlSeconds: number): Effect.Effect<SignedUrl, ForgeError> {
    return Effect.succeed({ url: `memory://upload/${encodeURIComponent(key)}`, method: "PUT", headers: { "content-type": mediaType, "content-length": String(byteCount) }, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() });
  }
  head(key: string): Effect.Effect<ObjectHead | null, ForgeError> {
    const o = this.objects.get(key);
    return Effect.succeed(o ? { byteCount: o.bytes.length, mediaType: o.mediaType, generation: o.generation } : null);
  }
  digest(key: string, maxBytes: number): Effect.Effect<{ sha256: string; byteCount: number }, ForgeError> {
    const o = this.objects.get(key);
    if (!o) return Effect.fail(err("NotFound", "object missing"));
    if (o.bytes.length > maxBytes) return Effect.fail(err("PayloadTooLarge", "object exceeds policy"));
    return Effect.promise(async () => ({ sha256: await sha256Hex(o.bytes), byteCount: o.bytes.length }));
  }
  seal(stagingKey: string, sealedKey: string, mediaType: string): Effect.Effect<{ generation: string | null }, ForgeError> {
    const o = this.objects.get(stagingKey);
    if (!o) return Effect.fail(err("NotFound", "staging object missing"));
    const generation = `g${++this.gen}`;
    this.objects.set(sealedKey, { bytes: o.bytes.slice(), mediaType, generation }); // copy: later staging writes cannot alter it
    return Effect.succeed({ generation });
  }
  presignDownload(key: string, ttlSeconds: number, mediaType: string): Effect.Effect<SignedUrl, ForgeError> {
    return Effect.succeed({ url: `memory://download/${encodeURIComponent(key)}`, method: "GET", headers: { accept: mediaType }, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() });
  }
  delete(key: string): Effect.Effect<void, ForgeError> {
    this.objects.delete(key);
    return Effect.void;
  }

  /** Test helpers standing in for a client's direct PUT / GET against the signed URL. */
  async simulateUpload(url: string, bytes: Uint8Array, mediaType: string): Promise<void> {
    const key = decodeURIComponent(url.replace("memory://upload/", ""));
    this.objects.set(key, { bytes, mediaType, generation: `g${++this.gen}` });
  }
  async simulateDownload(url: string): Promise<Uint8Array> {
    const key = decodeURIComponent(url.replace("memory://download/", ""));
    const o = this.objects.get(key);
    if (!o) throw new Error("missing");
    return o.bytes;
  }
}
