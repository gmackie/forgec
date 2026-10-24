// The content-addressed store module bytes come from. Every read is verified against its digest,
// so a store that loses or corrupts a blob makes the closure fail closed instead of running
// something other than what the manifest pins.
import { sha256 } from "./hash.ts";
import { LinkError } from "./manifest.ts";

export interface BlobStore {
  get(digest: string): Promise<Uint8Array | null>;
  has(digest: string): Promise<boolean>;
  put(bytes: Uint8Array): Promise<string>;
}

const key = (digest: string) => `blobs/${digest.slice("sha256:".length)}`;

export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async get(digest: string) {
    return this.blobs.get(digest) ?? null;
  }
  async has(digest: string) {
    return this.blobs.has(digest);
  }
  async put(bytes: Uint8Array) {
    const d = await sha256(bytes);
    this.blobs.set(d, bytes);
    return d;
  }
}

export interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<unknown | null>;
  put(key: string, value: Uint8Array | string): Promise<unknown>;
}

/** A local or deployed R2 bucket standing in for the unit store. */
export class R2BlobStore implements BlobStore {
  private readonly bucket: R2BucketLike;
  constructor(bucket: R2BucketLike) {
    this.bucket = bucket;
  }
  async get(digest: string) {
    const o = await this.bucket.get(key(digest));
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }
  async has(digest: string) {
    return (await this.bucket.head(key(digest))) !== null;
  }
  async put(bytes: Uint8Array) {
    const d = await sha256(bytes);
    await this.bucket.put(key(d), bytes);
    return d;
  }
}

/** Reads a blob and checks it hashes to its name. Missing or mismatched bytes are a LinkError. */
export async function verifiedBlob(store: BlobStore, digest: string, what: string): Promise<Uint8Array> {
  const bytes = await store.get(digest);
  if (!bytes) throw new LinkError("MissingModule", [`${what}: blob ${digest} is not in the unit store`]);
  const actual = await sha256(bytes);
  if (actual !== digest) throw new LinkError("ModuleDigestMismatch", [`${what}: blob ${digest} hashes to ${actual}`]);
  return bytes;
}
