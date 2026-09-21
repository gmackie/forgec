/**
 * OCI artifact storage on R2.
 *
 * Two callers share this layout: the console itself, through `OciBackend` with no HTTP hop at
 * all, and external clients through the `/v2` server in `registry-http.ts`. Keeping one layout
 * means a package published by the UI and a package pushed by `oras` are the same objects, and
 * a pull by either route returns the same bytes.
 *
 *   oci/<repo>/blobs/sha256/<hex>       blob bytes
 *   oci/<repo>/manifests/sha256/<hex>   manifest bytes, stored verbatim
 *   oci/<repo>/tags/<tag>               body is "sha256:<hex>" — a pointer, not a copy
 *
 * Tags point rather than duplicate, so `GET manifests/<tag>` and `GET manifests/sha256:...`
 * return byte-identical content. That is load-bearing: the client re-digests whatever it
 * receives and rejects a mismatch, so a tag that held its own copy would break digest-pinned
 * pulls the moment the two diverged.
 */
import { Problem } from "./model.js";
import type { OciBackend } from "./oci-backend.js";

/** The slice of the R2 binding this uses, so tests can supply an in-memory stand-in. */
export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<unknown | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    limit?: number;
    cursor?: string;
    startAfter?: string;
  }): Promise<{
    objects: { key: string }[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** `sha256:<hex>` is a legal path segment but an awkward object key; store it as a directory. */
export function digestKey(digest: string): string {
  if (!DIGEST.test(digest)) throw new Problem(400, "Invalid OCI digest.");
  return `sha256/${digest.slice(7)}`;
}

export interface R2OciOptions {
  bucket: R2Like;
  repository: string;
  /** Origin this registry is reachable at, for display and for `/v2` Location headers. */
  url: string;
}

export class R2Oci implements OciBackend {
  readonly url: string;
  readonly repository: string;
  private readonly bucket: R2Like;
  constructor(options: R2OciOptions) {
    if (
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
        options.repository,
      )
    )
      throw new Error("Invalid OCI repository path");
    this.bucket = options.bucket;
    this.repository = options.repository;
    this.url = new URL(options.url).origin;
  }

  private base() {
    return `oci/${this.repository}`;
  }
  blobKey(digest: string) {
    return `${this.base()}/blobs/${digestKey(digest)}`;
  }
  manifestKey(digest: string) {
    return `${this.base()}/manifests/${digestKey(digest)}`;
  }
  tagKey(tag: string) {
    return `${this.base()}/tags/${tag}`;
  }
  tagPrefix() {
    return `${this.base()}/tags/`;
  }

  async headBlob(digest: string): Promise<boolean> {
    return (await this.bucket.head(this.blobKey(digest))) !== null;
  }

  async putBlob(digest: string, text: string): Promise<void> {
    await this.bucket.put(this.blobKey(digest), text);
  }

  async getBlob(digest: string, limit: number): Promise<string> {
    const object = await this.bucket.get(this.blobKey(digest));
    if (!object) throw new Problem(404, "OCI artifact was not found.");
    const text = await object.text();
    if (new TextEncoder().encode(text).length > limit)
      throw new Problem(413, "OCI response exceeds the supported size.");
    return text;
  }

  /** Resolve a tag or digest to the manifest's own digest. */
  private async resolve(reference: string): Promise<string | null> {
    if (DIGEST.test(reference)) return reference;
    const pointer = await this.bucket.get(this.tagKey(reference));
    if (!pointer) return null;
    const digest = (await pointer.text()).trim();
    return DIGEST.test(digest) ? digest : null;
  }

  async headManifest(reference: string): Promise<boolean> {
    const digest = await this.resolve(reference);
    if (!digest) return false;
    return (await this.bucket.head(this.manifestKey(digest))) !== null;
  }

  async putManifest(tag: string, text: string, _mediaType: string): Promise<void> {
    // Content first, pointer last: a tag never names a manifest that is not yet readable.
    const digest = await sha256Hex(text);
    await this.bucket.put(this.manifestKey(`sha256:${digest}`), text);
    if (!DIGEST.test(tag)) await this.bucket.put(this.tagKey(tag), `sha256:${digest}`);
  }

  async getManifest(reference: string, limit: number): Promise<string | null> {
    const digest = await this.resolve(reference);
    if (!digest) return null;
    const object = await this.bucket.get(this.manifestKey(digest));
    if (!object) return null;
    const text = await object.text();
    if (new TextEncoder().encode(text).length > limit)
      throw new Problem(413, "OCI response exceeds the supported size.");
    return text;
  }

  async listTags(): Promise<string[]> {
    const prefix = this.tagPrefix();
    const tags: string[] = [];
    let cursor: string | undefined;
    // Same bound the HTTP backend applies, so neither route can be walked indefinitely.
    for (let page = 0; page < 20; page++) {
      const listed = await this.bucket.list({
        prefix,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of listed.objects) tags.push(object.key.slice(prefix.length));
      if (!listed.truncated) return tags;
      cursor = listed.cursor;
      if (!cursor) return tags;
    }
    throw new Error("OCI tag pagination exceeded its limit");
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
