import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";
import { Evaluations } from "./evaluation.js";
const p = "@forgegraph/foundation/trust/_/";
const ep = "@forgegraph/foundation/evaluation/_/";
function check(ok: unknown, detail: string) { return ok ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
const instant = (at: string) => Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid trust query instant") });
export class Trust {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
  private support(id: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id }, ctx);
      yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    });
  }
  signal(id: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const time = yield* instant(at);
      const row = yield* self.call("TrustSignal.get", { id }, ctx);
      yield* self.call("TrustSubject.get", { id: row.subject }, ctx);
      yield* self.call("TrustDimension.get", { id: row.dimension }, ctx);
      const kind = yield* self.call("SignalKind.get", { id: row.kind }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: kind.definition }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: row.issuer }, ctx);
      yield* self.support(row.support, ctx);
      const correction = yield* findTerminalFact(self.engine, p + "SignalCorrection", "signal", id, ctx);
      const dispute = yield* findTerminalFact(self.engine, p + "SignalDispute", "signal", id, ctx);
      const resolution = dispute ? yield* findTerminalFact(self.engine, p + "DisputeResolution", "dispute", dispute.id, ctx) : null;
      for (const fact of [correction, dispute, resolution]) if (fact) yield* self.support(fact.support, ctx);
      const corrected = !!correction && time >= Date.parse(String(correction.effectiveAt));
      const disputed = !!dispute && time >= Date.parse(String(dispute.effectiveAt)) &&
        (!resolution || time < Date.parse(String(resolution.effectiveAt)) || resolution.upheld === true);
      return { signal: row, correction, dispute, resolution, usable: !corrected && !disputed && time >= Date.parse(String(row.observedAt)) };
    });
  }
  review(id: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const time = yield* instant(at);
      const review = yield* self.call("TrustReview.get", { id }, ctx);
      yield* check(time >= Date.parse(String(review.createdAt)), "Trust review is not yet recorded");
      const dimension = yield* self.call("TrustDimension.get", { id: review.dimension }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: dimension.method }, ctx);
      yield* self.engine.call(ep + "EvaluationSet.get", { id: review.evaluations }, ctx);
      const members: { member: Wire; signal: Wire; usable: boolean }[] = [];
      const seen = new Set<string>();
      let cursor: unknown = review.head;
      while (cursor != null) {
        yield* check(members.length < 128, "Trust review exceeds 128 signals");
        const member = yield* self.call("SignalMember.get", { id: cursor }, ctx);
        yield* check(!seen.has(String(member.signal)), "Duplicate or cyclic trust signal membership");
        seen.add(String(member.signal));
        const signal = yield* self.signal(String(member.signal), at, ctx);
        yield* check(signal.signal.subject === review.subject && signal.signal.dimension === review.dimension, "Trust signal belongs to another subject or dimension");
        const observedAt = Date.parse(String(signal.signal.observedAt));
        yield* check(observedAt >= Date.parse(String(review.windowFrom)) && observedAt < Date.parse(String(review.windowUntil)), "Trust signal is outside assessment window");
        yield* check(Date.parse(String(signal.signal.createdAt)) <= Date.parse(String(review.createdAt)), "Trust signal was not bound before review");
        members.push({ member, signal: signal.signal, usable: signal.usable });
        cursor = member.next;
      }
      yield* check(members.length > 0, "Trust review needs supporting signals");
      return { review, dimension, members, usable: members.every(m => m.usable) };
    });
  }
  open(input: { subject: string; dimension: string; windowFrom: string; windowUntil: string; evaluations: string; signals: { signal: string; rationale: string }[] }, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      yield* check(input.signals.length > 0 && input.signals.length <= 128 && new Set(input.signals.map(s => s.signal)).size === input.signals.length, "Trust review requires 1..128 distinct signals");
      const start = yield* instant(input.windowFrom), end = yield* instant(input.windowUntil);
      yield* check(end > start, "Trust review window must be nonempty");
      yield* self.call("TrustSubject.get", { id: input.subject }, ctx);
      yield* self.call("TrustDimension.get", { id: input.dimension }, ctx);
      yield* self.engine.call(ep + "EvaluationSet.get", { id: input.evaluations }, ctx);
      for (const item of input.signals) {
        const row = yield* self.call("TrustSignal.get", { id: item.signal }, ctx);
        yield* check(row.subject === input.subject && row.dimension === input.dimension && Date.parse(String(row.observedAt)) >= start && Date.parse(String(row.observedAt)) < end, "Trust signal subject, dimension or window mismatch");
        yield* self.support(row.support, ctx);
      }
      const { idempotencyKey: _receipt, ...memberContext } = ctx;
      let head: string | null = null, depth = 0;
      for (const item of input.signals.toReversed()) {
        const member: Wire = yield* self.call("SignalMember.create", { ...item, next: head, depth: ++depth }, memberContext);
        head = String(member.id);
      }
      const { signals: _, ...body } = input;
      return yield* self.call("TrustReview.create", { ...body, head }, ctx);
    });
  }
  assess(review: string, input: { finish: string; score: string; confidence: string; explanation: string }, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const finish = yield* new Evaluations(self.engine).result(input.finish, ctx);
      const state = yield* self.review(review, String(finish.finishedAt), ctx);
      yield* check(state.usable, "Corrected or disputed signals require a fresh trust review");
      if (finish.support != null) yield* self.support(finish.support, ctx);
      return yield* self.call("TrustAssessment.create", { review, dimension: state.review.dimension, run: finish.run, ...input }, ctx);
    });
  }
  inspect(assessment: string, at: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.call("TrustAssessment.get", { id: assessment }, ctx);
      const finish = yield* new Evaluations(self.engine).result(String(row.finish), ctx);
      if (finish.support != null) yield* self.support(finish.support, ctx);
      const state = yield* self.review(String(row.review), at, ctx);
      return { assessment: row, ...state, usable: state.usable && (yield* instant(at)) >= Math.max(Date.parse(String(row.createdAt)), Date.parse(String(finish.finishedAt))) };
    });
  }
  linkRisk(assessment: string, trust: string, rationale: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const risk = yield* self.engine.call("@forgegraph/foundation/risk/_/RiskAssessment.get", { id: assessment }, ctx);
      yield* new Evaluations(self.engine).result(String(risk.evaluation), ctx);
      yield* self.support(risk.support, ctx);
      yield* check((yield* self.inspect(trust, String(risk.assessedAt), ctx)).usable, "Risk input requires a usable contextual trust assessment");
      return yield* self.call("RiskTrustInput.create", { assessment, trust, rationale }, ctx);
    });
  }
}
