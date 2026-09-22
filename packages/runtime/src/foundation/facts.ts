import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
import { Storage } from "../services.js";
/** An unreadable terminal fact must never be interpreted as absent. Probe presence
 * internally, then authorize the actual read through Engine. Append-only rows
 * cannot disappear between these reads through application operations. */
export function findTerminalFact(engine: Engine, resourceId: string, field: string, id: unknown, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
  return Effect.gen(function* () {
    const resource = engine.model.resource(resourceId);
    const unique = resource.uniques.find(u => u.fields.length === 1 && u.fields[0] === field && u.within.length === 0 && !u.condition);
    if (!resource.decorators.appendOnly || !unique) return yield* Effect.fail(err("Internal", "Terminal fact requires append-only unique identity"));
    const values = { [field]: id };
    const key = engine.claimKey(resource, unique, values);
    if (!key) return yield* Effect.fail(err("ValidationFailed", "Terminal fact identity is required"));
    const storage = yield* Storage;
    const record = yield* storage.findUnique(ctx.tenant, resource, unique, key, values);
    if (!record) return null;
    return yield* engine.call(resourceId + ".get", { id: record.id }, ctx);
  }).pipe(Effect.provide(engine.layer));
}
