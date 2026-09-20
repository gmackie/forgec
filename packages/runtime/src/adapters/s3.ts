/** AWS S3 object store: real presigned PUT/GET, HEAD for verification, CopyObject to seal. */
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Effect } from "effect";
import { err, type ForgeError } from "../errors.js";
import type { ObjectHead, ObjectStoreAdapter, SignedUrl } from "../services.js";

export class S3ObjectStore implements ObjectStoreAdapter {
  readonly name = "s3";
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, region: string, client?: S3Client) {
    this.s3 = client ?? new S3Client({ region });
  }
  private wrap<A>(f: () => Promise<A>): Effect.Effect<A, ForgeError> {
    return Effect.tryPromise({ try: f, catch: (e) => err("StorageUnavailable", String((e as Error).message ?? e)) });
  }
  presignUpload(key: string, mediaType: string, byteCount: number, ttlSeconds: number): Effect.Effect<SignedUrl, ForgeError> {
    return this.wrap(async () => {
      const url = await getSignedUrl(this.s3, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mediaType, ContentLength: byteCount }), { expiresIn: ttlSeconds });
      return { url, method: "PUT", headers: { "content-type": mediaType, "content-length": String(byteCount) }, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    });
  }
  head(key: string): Effect.Effect<ObjectHead | null, ForgeError> {
    return this.wrap(async () => {
      try {
        const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        return { byteCount: Number(h.ContentLength ?? 0), mediaType: h.ContentType ?? null, generation: h.VersionId ?? h.ETag ?? null };
      } catch (e) {
        if ((e as { name?: string }).name === "NotFound" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    });
  }
  digest(key: string, maxBytes: number): Effect.Effect<{ sha256: string; byteCount: number }, ForgeError> {
    return this.wrap(async () => {
      const o = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await o.Body!.transformToByteArray();
      if (bytes.length > maxBytes) throw new Error("object exceeds policy");
      const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      return { sha256: [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""), byteCount: bytes.length };
    });
  }
  seal(stagingKey: string, sealedKey: string, mediaType: string): Effect.Effect<{ generation: string | null }, ForgeError> {
    return this.wrap(async () => {
      const r = await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${encodeURIComponent(stagingKey)}`, Key: sealedKey, ContentType: mediaType, MetadataDirective: "REPLACE" }));
      return { generation: r.VersionId ?? r.CopyObjectResult?.ETag ?? null };
    });
  }
  presignDownload(key: string, ttlSeconds: number, mediaType: string): Effect.Effect<SignedUrl, ForgeError> {
    return this.wrap(async () => {
      const url = await getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentType: mediaType }), { expiresIn: ttlSeconds });
      return { url, method: "GET", expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    });
  }
  delete(key: string): Effect.Effect<void, ForgeError> {
    return this.wrap(() => this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).then(() => undefined));
  }
}
