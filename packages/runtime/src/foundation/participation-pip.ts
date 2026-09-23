import { Effect } from "effect";
import type { Authorizer, AuthzRequest, PipValue } from "../gatekeeper.js";
import type { ForgeError } from "../errors.js";
/** Bridge live participation facts to an independently defined policy. The caller
 * supplies a tenant-scoped typed principal mapping and authorized fact reader.
 * Allows are deliberately uncacheable: revocation and time boundaries are checked
 * for every decision, including repeated reads of an unchanged business record. */
export function participationPipAuthorizer(base: Authorizer, read: (request: AuthzRequest) => Effect.Effect<PipValue[], ForgeError>): Authorizer {
  return {
    get epoch() { return base.epoch; },
    knownObligations: base.knownObligations,
    requirements: () => [],
    liveAttributes: true,
    rowFilterFor: () => null,
    decide: request => Effect.gen(function* () {
      const attributes = yield* read(request);
      return yield* base.decide({ ...request, attributes });
    }),
  };
}
