import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import type { ForgeError } from "../errors.js";
const prefix = "@forgegraph/foundation/evidence/_/";
/** Evidence describes support for a conclusion, never its subject or verdict.
 * Normal engine authorization governs each bundle/item and referenced artifact. */
export class Evidence {
  constructor(private readonly engine: Engine) {}
  record(input: { bundle: string; source: string; sourceRecord: string; kind: string; observedAt: string; provenance: string; revision?: string; digest?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    return this.engine.call(prefix + "EvidenceItem.create", { ...input, revision: input.revision ?? null, digest: input.digest ?? null }, ctx);
  }
  items(bundle: string, ctx: CallContext, page: {cursor?: string; limit?: number} = {}) {
    return this.engine.call(prefix + "EvidenceItem.list.byBundle", {params: {bundle}, ...page}, ctx);
  }
  artifact(item: string, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const fact = yield* self.engine.call(prefix + "EvidenceItem.get", {id: item}, ctx);
      return fact.revision == null ? null : yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", {id: fact.revision}, ctx);
    });
  }
}
