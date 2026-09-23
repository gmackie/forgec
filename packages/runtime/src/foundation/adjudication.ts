import { Evaluations } from "./evaluation.js";
import { Effect } from "effect";
import { decodeDecimal, formatMinor, toMinor } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Storage } from "../services.js";
import { Decisions } from "./decision.js";
import { Evidence } from "./evidence.js";
import { Ledger } from "./ledger.js";
import { findTerminalFact } from "./facts.js";
const p = "@forgegraph/foundation/adjudication/_/", ep = "@forgegraph/foundation/entitlement/_/", lp = "@forgegraph/foundation/ledger/_/";
function check(value: unknown, detail: string) { return value ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
export interface OpenAdjudication { key: string; coverage: string; coverageAt: string; decisionCase: string; approvedOption: string; requested: string; unit: string; itemCount: number; support: string; reconsideration?: string }
export class Adjudications {
  constructor(private readonly engine: Engine) {}
  private call(op: string, body: Wire, ctx: CallContext) { return this.engine.call(p + op, body, ctx); }
  private find(resource: string, values: Wire, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const model = self.engine.model.resource(p + resource), unique = model.uniques.find(u => !u.condition && u.fields.length === Object.keys(values).length && u.fields.every(f => Object.hasOwn(values, f)))!;
      const row = yield* (yield* Storage).findUnique(ctx.tenant, model, unique, self.engine.claimKey(model, unique, values)!, values);
      return row ? yield* self.call(resource + ".get", { id: row.id }, ctx) : null;
    }).pipe(Effect.provide(self.engine.layer));
  }
  private evidence(id: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () { const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id }, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx); });
  }
  open(input: OpenAdjudication, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.evidence(input.support, ctx);
      yield* check((yield* new Decisions(self.engine).state(input.decisionCase, ctx)).events.length === 0, "Adjudication must pin its Decision before responses");
      if (input.reconsideration) yield* check(yield* self.determination(input.reconsideration, ctx), "Reconsideration requires a determined predecessor");
      const coverage = yield* self.engine.call(ep + "Entitlement.get", { id: input.coverage }, ctx);
      const requested = yield* Effect.try({ try: () => decodeDecimal(input.requested, { scale: 6 }), catch: () => err("ValidationFailed", "Invalid requested quantity") });
      yield* check(coverage.quantity == null || toMinor(requested, 6) <= toMinor(String(coverage.quantity), 6), "Request exceeds pinned coverage quantity");
      const end = yield* findTerminalFact(self.engine, ep + "EntitlementEnd", "entitlement", input.coverage, ctx);
      return yield* self.call("AdjudicationCase.create", { ...input, reconsideration: input.reconsideration ?? null, coverageEnd: end?.id ?? null }, ctx);
    });
  }
  item(adjudicationCase: string, ordinal: number, requested: string, evaluation: string, support: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const record = yield* self.call("AdjudicationCase.get", { id: adjudicationCase }, ctx);
      yield* check((yield* new Decisions(self.engine).state(String(record.decisionCase), ctx)).events.length === 0, "Items must be pinned before Decision responses");
      yield* self.evidence(support, ctx);
      yield* new Evaluations(self.engine).result(evaluation, ctx);
      return yield* self.call("AdjudicationItem.create", { adjudicationCase, ordinal, requested, evaluation, support }, ctx);
    });
  }
  private context(id: string, ctx: CallContext): Effect.Effect<{ record: Wire; items: Wire[]; decision: Wire; approved: boolean }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const record = yield* self.call("AdjudicationCase.get", { id }, ctx), coverage = yield* self.engine.call(ep + "Entitlement.get", { id: record.coverage }, ctx);
      yield* check(coverage.quantity == null || toMinor(String(record.requested), 6) <= toMinor(String(coverage.quantity), 6), "Request exceeds pinned coverage quantity");
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: coverage.holder }, ctx);
      yield* self.engine.call(ep + "RightDefinition.get", { id: coverage.right }, ctx);
      yield* self.engine.call(ep + "EntitlementScope.get", { id: coverage.scope }, ctx);
      if (record.coverageEnd != null) yield* self.engine.call(ep + "EntitlementEnd.get", { id: record.coverageEnd }, ctx);
      yield* self.evidence(record.support, ctx);
      const state = yield* new Decisions(self.engine).state(String(record.decisionCase), ctx);
      yield* check(state.outcome, "Adjudication requires a validated terminal Decision outcome");
      const first = Date.parse(String(state.events[0]?.createdAt));
      yield* check(Date.parse(String(record.createdAt)) < first, "Decision predates the adjudication context");
      const items: Wire[] = []; let total = 0n;
      for (let ordinal = 0; ordinal < Number(record.itemCount); ordinal++) {
        const item = yield* self.find("AdjudicationItem", { adjudicationCase: id, ordinal }, ctx);
        yield* check(item, "Adjudication item snapshot is incomplete");
        yield* check(Date.parse(String(item!.createdAt)) < first, "Item was added after Decision responses");
        yield* self.evidence(item!.support, ctx);
        const finish = yield* new Evaluations(self.engine).result(String(item!.evaluation),ctx);
        yield* check(finish.outcome === "Completed", "Item evaluation did not complete");
        yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationRun.get", { id: finish.run }, ctx);
        if (finish.support != null) yield* self.evidence(finish.support, ctx);
        total += toMinor(String(item!.requested), 6); items.push(item!);
      }
      yield* check(total === toMinor(String(record.requested), 6), "Item requests must exactly sum to the case request");
      return { record, items, decision: state.outcome!, approved: state.outcome!.selected === record.approvedOption };
    });
  }
  determine(adjudicationCase: string, authorized: string, reason: string, support: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const context = yield* self.context(adjudicationCase, ctx);
      const amount = yield* Effect.try({ try: () => decodeDecimal(authorized, { scale: 6 }), catch: () => err("ValidationFailed", "Invalid authorized quantity") });
      yield* check(toMinor(amount, 6) <= toMinor(String(context.record.requested), 6), "Determination exceeds requested quantity");
      yield* self.evidence(support, ctx);
      return yield* self.call("Determination.create", { adjudicationCase, decision: context.decision.id, authorized, unit: context.record.unit, reason, support, recordedBy: ctx.actor }, ctx);
    });
  }
  determination(adjudicationCase: string, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const determination = yield* self.find("Determination", { adjudicationCase }, ctx);
      if (!determination) { yield* self.call("AdjudicationCase.get", { id: adjudicationCase }, ctx); return null; }
      const context = yield* self.context(adjudicationCase, ctx);
      yield* check(toMinor(String(determination.authorized), 6) <= toMinor(String(context.record.requested), 6), "Determination exceeds requested quantity");
      yield* check(determination.decision === context.decision.id && context.approved === (toMinor(String(determination.authorized), 6) > 0n), "Determination does not match authoritative Decision");
      yield* self.evidence(determination.support, ctx);
      return determination;
    });
  }
  private verified(id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { const row = yield* self.call("Determination.get", { id }, ctx); const determined = yield* self.determination(String(row.adjudicationCase), ctx); yield* check(determined?.id === id, "Determination is not authoritative"); return row; }); }
  authorize(determination: string, fulfillment: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { yield* self.verified(determination, ctx); return yield* self.call("AuthorizedOutcomeLink.create", { determination, fulfillment }, ctx); }); }
  reason(determination: string, item: string, reason: string, support: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { yield* self.verified(determination, ctx); yield* self.evidence(support, ctx); return yield* self.call("AdjustmentReasonLink.create", { determination, item, reason, support }, ctx); }); }
  planSettlement(determination: string, book: string, debit: string, credit: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { const row = yield* self.verified(determination, ctx); yield* check(toMinor(String(row.authorized), 6) > 0n, "Rejected determinations cannot settle"); return yield* self.call("SettlementIntent.create", { determination, book, debit, credit, quantity: row.authorized, unit: row.unit }, ctx); }); }
  settle(intentId: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const intent = yield* self.call("SettlementIntent.get", { id: intentId }, ctx);
      yield* self.verified(String(intent.determination), ctx);
      const quantity = yield* Effect.try({ try: () => decodeDecimal(String(intent.quantity), { scale: 6 }), catch: () => err("ValidationFailed", "Invalid settlement quantity") });
      const posting = yield* new Ledger(self.engine).post({ book: String(intent.book), key: `adjudication:${intentId}`, policy: "balanced", reason: `Adjudication settlement ${intentId}`, entries: [{ account: String(intent.debit), quantity: formatMinor(-toMinor(quantity, 6), 6) }, { account: String(intent.credit), quantity }] }, ctx);
      return yield* self.call("SettlementLink.create", { intent: intentId, posting: posting.id }, { ...ctx, idempotencyKey: `adjudication:settlement:${intentId}` });
    });
  }
  settlement(intentId: string, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const intent = yield* self.call("SettlementIntent.get", { id: intentId }, ctx); yield* self.verified(String(intent.determination), ctx);
      const link = yield* self.find("SettlementLink", { intent: intentId }, ctx); if (!link) return null;
      const rebuilt = yield* new Ledger(self.engine).rebuild(String(intent.book), ctx);
      yield* check(rebuilt.groupIds.includes(String(link.posting)), "Settlement posting is not a valid Ledger group");
      const posting = yield* self.engine.call(lp + "PostingGroup.get", { id: link.posting }, ctx);
      yield* check(posting.key === `adjudication:${intentId}`, "Settlement posting has a different logical scope");
      const debit = yield* self.engine.call(lp + "Entry.get", { id: posting.head }, ctx);
      const credit = yield* self.engine.call(lp + "Entry.get", { id: debit.next }, ctx);
      yield* check(debit.account === intent.debit && credit.account === intent.credit && credit.next == null && toMinor(String(debit.quantity), 6) === -toMinor(String(intent.quantity), 6) && toMinor(String(credit.quantity), 6) === toMinor(String(intent.quantity), 6), "Settlement posting exceeds or differs from authorization");
      return link;
    });
  }
  explain(determination: string, intent: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { const row = yield* self.verified(determination, ctx); return yield* self.call("ExplanationLink.create", { determination, intent, support: row.support }, ctx); }); }
}
