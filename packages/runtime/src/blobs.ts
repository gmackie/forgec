/**
 * Blob upload lifecycle (plan §13). Metadata lives in the resource record
 * (server-owned fields); bytes live in the object store under private keys.
 * Only sealed objects are ever served.
 */
import { Effect } from "effect";
import type { Wire } from "./decode.js";
import { canonicalize } from "./decode.js";
import type { CallContext, Engine } from "./engine.js";
import { err, type ForgeError } from "./errors.js";
import type { Resource } from "./model.js";
import { Clock, IdGen, Objects, Storage, type CommitPlan, type RuntimeServices } from "./services.js";

const UPLOAD_TTL = 900;
const DOWNLOAD_TTL = 300;

export class Blobs {
  constructor(private readonly engine: Engine) {}

  private stagingKey(tenant: string, r: Resource, id: string, attempt: number): string {
    return `staging/${tenant}/${this.engine.model.wireName(r.id)}/${id}/${attempt}`;
  }
  private sealedKey(tenant: string, r: Resource, id: string, generation: number, token?: string): string {
    return `sealed/${tenant}/${this.engine.model.wireName(r.id)}/${id}/${generation}${token ? `/${token}` : ""}`;
  }

  /** A metadata mutation on the blob record, through the normal commit path (version guard, audit, outbox). */
  private mutate(r: Resource, id: string, expectedVersion: number, kind: string, patch: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const storage = yield* Storage;
      const before = yield* storage.get(ctx.tenant, r, id);
      if (!before || before["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      if (before["version"] !== expectedVersion) return yield* Effect.fail(err("VersionConflict", `expected version ${expectedVersion}, current is ${before["version"]}`));
      const now = (yield* Clock).now();
      const opId = (yield* IdGen).opId();
      const after: Wire = { ...before, ...patch, version: expectedVersion + 1, updatedAt: now };
      const plan: CommitPlan = {
        tenant: ctx.tenant, opId, actor: ctx.actor, at: now, resource: r, kind: "update", id, expectedVersion, before, after,
        claims: [], references: [], dependents: [], hardDelete: false,
        audit: { tenant: ctx.tenant, opId, resource: r.id, recordId: id, kind, newVersion: expectedVersion + 1, actor: ctx.actor, at: now },
        outbox: r.decorators.audited ? [{ tenant: ctx.tenant, opId, ordinal: 0, channel: `${r.id}.changes`, message: "Updated", payload: { id, version: expectedVersion + 1, uploadState: after["uploadState"] }, createdAt: now }] : [],
      };
      yield* storage.commit(plan);
      return canonicalize(self.engine.model, r, after);
    });
  }

  beginUpload(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const expectedVersion = body["expectedVersion"];
      if (typeof expectedVersion !== "number") return yield* Effect.fail(err("PreconditionRequired", "expectedVersion is required"));
      const policy = r.content!;
      const mediaType = String(body["mediaType"] ?? "");
      const byteCount = Number(body["byteCount"]);
      if (!policy.mediaTypes.includes(mediaType)) return yield* Effect.fail(err("ValidationFailed", `media type ${mediaType} is not allowed`, { fields: [{ path: "mediaType", code: "NotAllowed", message: `allowed: ${policy.mediaTypes.join(", ")}` }] }));
      if (!Number.isInteger(byteCount) || byteCount <= 0) return yield* Effect.fail(err("ValidationFailed", "byteCount must be a positive integer", { fields: [{ path: "byteCount", code: "InvalidInteger", message: "positive integer required" }] }));
      if (byteCount > policy.maxBytes) return yield* Effect.fail(err("PayloadTooLarge", `${byteCount} bytes exceeds the limit of ${policy.maxBytes}`));
      const current = yield* (yield* Storage).get(ctx.tenant, r, id);
      if (!current) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      const attempt = Number(current["uploadAttempt"] ?? 0) + 1;
      const key = self.stagingKey(ctx.tenant, r, id, attempt);
      const upload = yield* (yield* Objects).presignUpload(key, mediaType, byteCount, UPLOAD_TTL);
      const record = yield* self.mutate(r, id, expectedVersion, "blob.beginUpload", { uploadState: "uploading", uploadAttempt: attempt, stagedMediaType: mediaType, stagedByteCount: byteCount }, ctx);
      return { record, upload };
    });
  }

  finalizeUpload(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const expectedVersion = body["expectedVersion"];
      if (typeof expectedVersion !== "number") return yield* Effect.fail(err("PreconditionRequired", "expectedVersion is required"));
      const storage = yield* Storage;
      const objects = yield* Objects;
      const current = yield* storage.get(ctx.tenant, r, id);
      if (!current) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      if (current["version"] !== expectedVersion) return yield* Effect.fail(err("VersionConflict", "blob changed before finalization"));
      if (current["uploadState"] !== "uploading") return yield* Effect.fail(err("InvalidTransition", `cannot finalize from ${current["uploadState"]}`));
      const attempt = Number(current["uploadAttempt"]);
      const staging = self.stagingKey(ctx.tenant, r, id, attempt);
      const head = yield* objects.head(staging);
      if (!head) return yield* Effect.fail(err("ValidationFailed", "no bytes have been uploaded for this intent", { fields: [{ path: "content", code: "Missing", message: "upload the bytes to the signed URL first" }] }));
      const expectedBytes = Number(current["stagedByteCount"]);
      const expectedType = String(current["stagedMediaType"]);
      const policy = r.content!;
      const verified = head.byteCount === expectedBytes && head.byteCount <= policy.maxBytes && (head.mediaType === null || head.mediaType === expectedType);
      if (!verified) {
        const rec = yield* self.mutate(r, id, expectedVersion, "blob.reject", { uploadState: "rejected" }, ctx);
        yield* objects.delete(staging);
        return rec;
      }
      const generation = Number(current["contentGeneration"] ?? 0) + 1;
      // Every contender gets a private immutable key. A failed metadata CAS can
      // leave an orphan, but can never overwrite the object named by the winner.
      const token = crypto.randomUUID();
      const sealed = self.sealedKey(ctx.tenant, r, id, generation, token);
      const { generation: providerGen } = yield* objects.seal(staging, sealed, expectedType);
      // Hash the immutable copy, never the still-writable staging upload.
      const { sha256, byteCount } = yield* objects.digest(sealed, policy.maxBytes);
      if (byteCount !== expectedBytes) {
        yield* objects.delete(sealed);
        return yield* self.mutate(r, id, expectedVersion, "blob.reject", { uploadState: "rejected" }, ctx);
      }
      const rec = yield* self.mutate(r, id, expectedVersion, "blob.finalize", { uploadState: "ready", mediaType: expectedType, byteCount, digest: `sha256:${sha256}`, contentGeneration: generation, sealedGeneration: `forge-sealed/1|${token}|${providerGen ?? ""}` }, ctx);
      yield* objects.delete(staging);
      // A newly sealed generation starts `pending`: sealing never clears content (plan §7.3).
      return { ...rec, inspection: { state: "pending", generation } };
    });
  }

  download(r: Resource, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError, RuntimeServices> {
    const self = this;
    return Effect.gen(function* () {
      const id = String(body["id"]);
      const current = yield* (yield* Storage).get(ctx.tenant, r, id);
      if (!current || current["deletedAt"]) return yield* Effect.fail(err("NotFound", `${r.name} ${id} not found`));
      if (current["uploadState"] !== "ready") return yield* Effect.fail(err("InvalidTransition", `content is not ready (${current["uploadState"]})`));
      // Content inspection verdict (plan §7.3): quarantined and review-required never serve; pending only in the lenient profile.
      yield* self.engine.governance.checkReadable(r, id, Number(current["contentGeneration"]), ctx);
      const sealedGeneration = String(current["sealedGeneration"] ?? "");
      let token: string | undefined;
      if (sealedGeneration.startsWith("forge-sealed/")) {
        const parts = sealedGeneration.split("|");
        if (parts[0] !== "forge-sealed/1" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[1] ?? "")) return yield* Effect.fail(err("ValidationFailed", "invalid sealed object identity"));
        token = parts[1];
      }
      // Legacy rows retain their original generation-only object key.
      const key = self.sealedKey(ctx.tenant, r, id, Number(current["contentGeneration"]), token);
      const signed = yield* (yield* Objects).presignDownload(key, DOWNLOAD_TTL, String(current["mediaType"]));
      return { ...signed, mediaType: current["mediaType"], byteCount: current["byteCount"], digest: current["digest"] };
    });
  }
}
