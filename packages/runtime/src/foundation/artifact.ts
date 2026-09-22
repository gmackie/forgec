import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
const prefix = "@forgegraph/foundation/artifact/_/";
/** Publication accepts only sealed write-once content. Schema rules also enforce
 * digest/type/size equality, including callers of the underlying create operation. */
export class Artifacts {
  constructor(private readonly engine: Engine) {}
  publish(input: { artifact: string; content: string; digest: string; specificationPin?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const content = yield* self.engine.call(prefix + "ArtifactContent.get", { id: input.content }, ctx);
      if (content.uploadState !== "ready" || content.digest !== input.digest) return yield* Effect.fail(err("ValidationFailed", "Publication requires sealed content with the expected digest"));
      return yield* self.engine.call(prefix + "ArtifactRevision.create", {
        artifact: input.artifact, content: input.content, digest: content.digest,
        mediaType: content.mediaType, byteCount: content.byteCount,
        specificationPin: input.specificationPin ?? null,
      }, ctx);
    });
  }
  download(revision: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const record = yield* self.engine.call(prefix + "ArtifactRevision.get", { id: revision }, ctx);
      return yield* self.engine.call(prefix + "ArtifactContent.download", { id: record.content }, ctx);
    });
  }
}
