import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { decodeDatetime } from "../codecs.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";
const p = "@forgegraph/foundation/qualification/_/";
const evidence = "@forgegraph/foundation/evidence/_/";
/** Qualification is a business fact; matching a requirement never grants authority. */
export class Qualifications {
  constructor(private readonly engine: Engine) {}
  award(input: { subject: string; definition: string; level?: string; issuer: string; issuerRecord: string; issuedAt: string; expiresAt?: string; support?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(p + "QualificationSubject.get", { id: input.subject }, ctx);
      yield* self.engine.call(p + "QualificationDefinition.get", { id: input.definition }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: input.issuer }, ctx);
      if (input.level) yield* self.engine.call(p + "QualificationLevel.get", { id: input.level }, ctx);
      if (input.support) yield* self.readSupport(input.support, ctx);
      return yield* self.engine.call(p + "Qualification.create", { ...input, level: input.level ?? null, expiresAt: input.expiresAt ?? null, support: input.support ?? null, recordedBy: ctx.actor }, ctx);
    });
  }
  revoke(qualification: string, effectiveAt: string, reason: string, ctx: CallContext) {
    return this.engine.call(p + "QualificationRevocation.create", { qualification, effectiveAt, reason, recordedBy: ctx.actor }, ctx);
  }
  private readSupport(sealId: string, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const seal = yield* self.engine.call(evidence + "EvidenceSeal.get", { id: sealId }, ctx);
      yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    });
  }
  /** Bounded full lookup, consuming storage cursors rather than treating page one
   * as definitive. Domain rank order is comparable only within an exact definition. */
  satisfies(subject: string, requirement: string, at: string, ctx: CallContext): Effect.Effect<{ qualified: boolean; qualification: string | null }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid qualification lookup instant") });
      yield* self.engine.call(p + "QualificationSubject.get", { id: subject }, ctx);
      const required = yield* self.engine.call(p + "QualificationRequirement.get", { id: requirement }, ctx);
      yield* self.engine.call(p + "QualificationDefinition.get", { id: required.definition }, ctx);
      const minimum = required.minimumLevel == null ? null : yield* self.engine.call(p + "QualificationLevel.get", { id: required.minimumLevel }, ctx);
      let cursor: string | undefined, count = 0, pages = 0;
      do {
        if (++pages > 3) return yield* Effect.fail(err("BudgetExceeded", "Qualification lookup exceeded three storage pages"));
        const page = yield* self.engine.call(p + "Qualification.list.bySubject", { params: { subject }, limit: 50, ...(cursor ? { cursor } : {}) }, ctx);
        for (const item of page.items as Wire[]) {
          if (++count > 128) return yield* Effect.fail(err("BudgetExceeded", "Qualification lookup supports at most 128 candidates"));
          if (item.definition !== required.definition || instant < Date.parse(String(item.issuedAt)) || item.expiresAt != null && instant >= Date.parse(String(item.expiresAt))) continue;
          const award = yield* self.engine.call(p + "Qualification.get", { id: item.id }, ctx);
          const revoked = yield* findTerminalFact(self.engine, p + "QualificationRevocation", "qualification", award.id, ctx);
          if (revoked && instant >= Date.parse(String(revoked.effectiveAt))) continue;
          if (minimum != null) {
            if (award.level == null) continue;
            const level = yield* self.engine.call(p + "QualificationLevel.get", { id: award.level }, ctx);
            if (Number(level.rank) < Number(minimum.rank)) continue;
          }
          yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: award.issuer }, ctx);
          if (award.support != null) yield* self.readSupport(String(award.support), ctx);
          return { qualified: true, qualification: String(award.id) };
        }
        cursor = page.next == null ? undefined : String(page.next);
      } while (cursor);
      return { qualified: false, qualification: null };
    });
  }
}
