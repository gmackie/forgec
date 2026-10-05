import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Cases } from './case-management.js';
import { Evidence } from './evidence.js';
import { Evaluations } from './evaluation.js';
import { Decisions } from './decision.js';
import { Billing } from './billing.js';
import { Fulfillments } from './fulfillment.js';
import { Changes } from './change.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/dispute-appeal/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
export class Disputes {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(pkg: string, type: string, id: unknown, ctx: CallContext) { return this.engine.call('@forgegraph/foundation/' + pkg + '/_/' + type + '.get', { id }, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const seal = yield* self.read('evidence', 'EvidenceSeal', id, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx); });
 }
 private charge(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const claim = yield* findTerminalFact(self.engine, '@forgegraph/foundation/billing/_/BilledCharge', 'charge', id, ctx);
   if (!claim) return yield* fail('Contested charge or adjustment must be issued');
   const bill = yield* new Billing(self.engine).inspect(String(claim.bill), ctx);
   if (!bill.issue || !bill.charges.some(c => c.id === id)) return yield* fail('Charge not in issued bill');
   return yield* self.read('billing', 'BillingCharge', id, ctx);
  });
 }
 private contested(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('ContestedFact.get', { id }, ctx);
   if (row.decision) {
    const outcome = yield* self.read('decision', 'DecisionOutcome', row.decision, ctx), state = yield* new Decisions(self.engine).state(String(outcome.decisionCase), ctx);
    if (state.outcome?.id !== outcome.id || String(state.terminal?.createdAt) > at) return yield* fail('Original decision is not admitted');
   }
   if (row.charge) { const charge = yield* self.charge(String(row.charge), ctx); if (String(charge.ratedAt) > at) return yield* fail('Charge postdates filing'); }
   if (row.finding) { const finding = yield* self.read('assurance', 'Finding', row.finding, ctx); const result = yield* new Evaluations(self.engine).result(String(finding.finish), ctx); if (String(result.finishedAt) > at) return yield* fail('Finding postdates filing'); }
   if (row.outcome) { const end = yield* self.read('fulfillment', 'FulfillmentEnd', row.outcome, ctx); const work = yield* new Fulfillments(self.engine).status(String(end.fulfillment), ctx); if (work.end?.id !== end.id || String(end.endedAt) > at) return yield* fail('Original outcome is not terminal'); }
   return row;
  });
 }
 private mandate(row: Wire, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const mandate = yield* self.call('ReviewMandate.get', { id: row.mandate }, ctx), reviewer = yield* self.read('participation', 'Participation', row.reviewer, ctx);
   const end = yield* findTerminalFact(self.engine, p + 'ReviewMandateEnd', 'mandate', mandate.id, ctx), memberEnd = yield* findTerminalFact(self.engine, '@forgegraph/foundation/participation/_/ParticipationEnd', 'participation', reviewer.id, ctx);
   if (String(mandate.from) > at || String(mandate.until) <= at || end && String(end.at) <= at || String(reviewer.validFrom) > at || reviewer.validUntil && String(reviewer.validUntil) <= at || memberEnd && String(memberEnd.effectiveAt) <= at) return yield* fail('Review mandate or participation is not active');
   yield* self.read('party', 'Party', mandate.authority, ctx); yield* self.read('party', 'Party', reviewer.participant, ctx);
   yield* self.support(mandate.support, ctx);
   return reviewer;
  });
 }
 inspect(id: string, ctx: CallContext): Effect.Effect<{ row: Wire; contested: Wire }, ForgeError> { return this.inspectLevel(id, ctx, 0); }
 private inspectLevel(id: string, ctx: CallContext, depth: number): Effect.Effect<{ row: Wire; contested: Wire }, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   if (depth >= 8) return yield* fail('Appeal depth exceeds eight');
   const row = yield* self.call('Dispute.get', { id }, ctx), activity = yield* new Cases(self.engine).state(String(row.case), ctx), contested = yield* self.contested(String(row.contested), String(row.filedAt), ctx);
   if (String(activity.row.openedAt) > String(row.filedAt)) return yield* fail('Dispute predates its case');
   yield* self.read('party', 'Party', row.appellant, ctx);
   for (const field of ['requestedRemedy', 'jurisdiction', 'policy']) yield* self.read('specification', 'SpecificationPin', row[field], ctx);
   yield* self.support(row.support, ctx);
   const reviewer = yield* self.mandate(row, String(row.filedAt), ctx), decision = yield* new Decisions(self.engine).state(String(row.decision), ctx), elector = yield* self.read('decision', 'DecisionElector', decision.decisionCase.electors, ctx);
   if (elector.participation !== row.reviewer || elector.next != null || decision.decisionCase.rule !== 'Single' || decision.decisionCase.participationSet !== reviewer.participationSet || String(decision.decisionCase.createdAt) < String(row.filedAt) || String(decision.decisionCase.deadline) > String(row.reviewDeadline)) return yield* fail('Review requires the mandated single reviewer and deadline');
   yield* self.read('evaluation', 'EvaluationRun', row.evaluation, ctx);
   if (row.previous) yield* self.resultLevel(String(row.priorResult), ctx, depth + 1);
   return { row, contested };
  });
 }
 result(id: string, ctx: CallContext): Effect.Effect<{ row: Wire; dispute: Wire }, ForgeError> { return this.resultLevel(id, ctx, 0); }
 private resultLevel(id: string, ctx: CallContext, depth: number): Effect.Effect<{ row: Wire; dispute: Wire }, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('DisputeResult.get', { id }, ctx), dispute = yield* self.inspectLevel(String(row.dispute), ctx, depth), review = yield* new Evaluations(self.engine).result(String(row.review), ctx), decision = yield* new Decisions(self.engine).state(String(dispute.row.decision), ctx);
   if (decision.outcome?.id !== row.decision || String(decision.terminal?.createdAt) > String(row.at) || String(decision.terminal?.createdAt) < String(review.finishedAt)) return yield* fail('Review must finish before the admitted decision and result');
   yield* self.mandate(dispute.row, String(decision.terminal!.createdAt), ctx);
   yield* self.support(row.support, ctx);
   return { row, dispute: dispute.row };
  });
 }
 remedy(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('DisputeRemedy.get', { id }, ctx), result = yield* self.result(String(row.result), ctx);
   yield* self.read('specification', 'SpecificationPin', row.implementation, ctx); yield* self.support(row.support, ctx);
   if (row.fulfillment) { const definition = yield* self.read('fulfillment', 'Fulfillment', row.fulfillment, ctx); if (definition.specificationPin !== row.implementation) return yield* fail('Remedy work does not implement the pinned remedy'); const work = yield* new Fulfillments(self.engine).status(String(row.fulfillment), ctx); if (work.phase !== 'completed' || work.coverage !== 'complete' || String(work.end!.endedAt) < String(result.row.at) || String(work.end!.endedAt) > String(row.at)) return yield* fail('Remedy work must complete after decision and before remedy record'); }
   if (row.adjustment) { const charge = yield* self.charge(String(row.adjustment), ctx), contested = yield* self.call('ContestedFact.get', { id: result.dispute.contested }, ctx); if (charge.adjustmentFor !== contested.charge || String(charge.ratedAt) < String(result.row.at) || String(charge.ratedAt) > String(row.at)) return yield* fail('Adjustment must correct this contested charge after review'); }
   if (row.change) { const change = yield* new Changes(self.engine).state(String(row.change), ctx); if (change.phase !== 'Completed') return yield* fail('Remedy change is not completed'); }
   return { row, result };
  });
 }
}
