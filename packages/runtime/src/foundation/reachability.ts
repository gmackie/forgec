import { Effect } from "effect";
import { findTerminalFact } from "./facts.js";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
const prefix = "@forgegraph/foundation/reachability/_/";

/** Contact points reach people; endpoints reach systems. The two are never interchangeable. */
export type Profile = "ContactPoint" | "Endpoint";

export interface LocatorDeclaration {
  locatorSet: string;
  kind: string;
  purpose: string;
  value: string;
  preference: number;
  validFrom: string;
  validUntil?: string;
}

export interface LocatorSelector {
  locatorSet: string;
  kind: string;
  purpose: string;
}

export interface ResolvedLocator {
  locator: string;
  locatorSet: string;
  value: string;
  preference: number;
  verified: boolean;
}

/** The field each profile's satellites key on, derived once rather than spelled at each site. */
const owner = (profile: Profile) => (profile === "ContactPoint" ? "contactPoint" : "endpoint");

/**
 * Reachability operations over the typed sidecar.
 *
 * Resolution is deliberately not a single indexed read. Preference orders candidates, but
 * whether a candidate is reachable *now* depends on its validity window and on whether a
 * terminal disposition has ended it — neither of which an index can answer. So the ordered
 * list is walked and the first surviving candidate wins, which is also why the page is
 * bounded: an unbounded scan here would be a scan of somebody's contact details.
 *
 * Nothing here decides whether a subject should be contacted. That is consent and
 * notification preference, and both live outside this package on purpose.
 */
export class Reachability {
  constructor(private readonly engine: Engine) {}
  private call(operation: string, input: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    return this.engine.call(prefix + operation, input, ctx);
  }

  declare(profile: Profile, input: LocatorDeclaration, ctx: CallContext) {
    return this.call(`${profile}.create`, {
      locatorSet: input.locatorSet, kind: input.kind, purpose: input.purpose,
      value: input.value, preference: input.preference,
      validFrom: input.validFrom, validUntil: input.validUntil ?? null,
    }, ctx);
  }

  verify(profile: Profile, locator: string, evidence: { verifiedAt: string; method: string; evidence: string }, ctx: CallContext) {
    return this.call(`${profile}Verification.create`, {
      [owner(profile)]: locator,
      verifiedAt: evidence.verifiedAt, method: evidence.method, evidence: evidence.evidence,
    }, ctx);
  }

  revoke(profile: Profile, locator: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call(`${profile}Disposition.create`, {
      [owner(profile)]: locator, replacement: null, effectiveAt, reason,
    }, ctx);
  }

  supersede(profile: Profile, locator: string, replacement: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.call(`${profile}Disposition.create`, {
      [owner(profile)]: locator, replacement, effectiveAt, reason,
    }, ctx);
  }

  /** The preferred locator reachable at `at`, or null when the set has none for that purpose. */
  resolve(profile: Profile, selector: LocatorSelector, at: string, ctx: CallContext, limit = 64): Effect.Effect<ResolvedLocator | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({
        try: () => Date.parse(decodeDatetime(at)),
        catch: () => err("ValidationFailed", "Invalid reachability instant"),
      });
      const page = yield* self.call(`${profile}.list.byLocatorSetKindPurpose`, {
        params: { locatorSet: selector.locatorSet, kind: selector.kind, purpose: selector.purpose },
        limit,
      }, ctx);
      const candidates = (page as { items?: Wire[] }).items ?? [];
      for (const candidate of candidates) {
        const from = Date.parse(String(candidate["validFrom"]));
        const until = candidate["validUntil"] == null ? null : Date.parse(String(candidate["validUntil"]));
        if (instant < from || (until !== null && instant >= until)) continue;
        const disposition = yield* findTerminalFact(self.engine, prefix + `${profile}Disposition`, owner(profile), candidate["id"], ctx);
        if (disposition && instant >= Date.parse(String(disposition["effectiveAt"]))) continue;
        const verification = yield* findTerminalFact(self.engine, prefix + `${profile}Verification`, owner(profile), candidate["id"], ctx);
        return {
          locator: String(candidate["id"]),
          locatorSet: String(candidate["locatorSet"]),
          value: String(candidate["value"]),
          preference: Number(candidate["preference"]),
          verified: verification != null && Date.parse(String(verification["verifiedAt"])) <= instant,
        };
      }
      if (page["next"] != null) return yield* Effect.fail(err("BudgetExceeded", "Reachability candidates exceed the lookup bound"));
      return null;
    });
  }

  listBySet(profile: Profile, locatorSet: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}) {
    return this.call(`${profile}.list.byLocatorSet`, { params: { locatorSet }, ...page }, ctx);
  }
}
