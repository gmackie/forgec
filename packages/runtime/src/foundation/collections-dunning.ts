import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { toMinor, formatMinor, decodeDatetime } from '../codecs.js';
import { err, type ForgeError } from '../errors.js';
import { Settlements, type SettlementAdmission } from './settlement.js';
import { Cases } from './case-management.js';
import { Notifications } from './notifications.js';
import { AgreementCatalog } from './agreement-catalog.js';
import { Decisions } from './decision.js';
import { Challenges } from './challenge.js';
import { Disputes } from './dispute-appeal.js';
import { Billing } from './billing.js';
import { Evidence } from './evidence.js';
import { Evaluations } from './evaluation.js';
import { Fulfillments } from './fulfillment.js';
import { Ledger } from './ledger.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/collections-dunning/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
/** Profile validates accounting treatment or external recovery scope. Neither implies payment. */
export type CollectionDispositionAdmission = (disposition: Wire, position: Wire, ctx: CallContext) => Effect.Effect<void, ForgeError>;
export class Collections {
 constructor(private readonly engine: Engine, private readonly admission: SettlementAdmission, private readonly dispositionAdmission?: CollectionDispositionAdmission) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(pkg: string, type: string, id: unknown, ctx: CallContext) { return this.engine.call('@forgegraph/foundation/' + pkg + '/_/' + type + '.get', { id }, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const seal = yield* self.read('evidence', 'EvidenceSeal', id, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx); });
 }
 state(id: string, instant: string, ctx: CallContext, knownAt?: string) {
  const self = this;
  return Effect.gen(function* () {
   const at = yield* Effect.try({ try: () => decodeDatetime(instant), catch: () => err('ValidationFailed', 'Invalid collection instant') }), row = yield* self.call('Collection.get', { id }, ctx), policy = yield* self.call('CollectionPolicy.get', { id: row.policy }, ctx), activity = yield* new Cases(self.engine).state(String(row.case), ctx);
   yield* self.read('specification', 'SpecificationPin', policy.definition, ctx);
   if (String(row.openedAt) > String(row.createdAt) || at < String(row.openedAt) || String(activity.row.openedAt) > String(row.openedAt)) return yield* fail('Collection query predates opening');
   const settlements = new Settlements(self.engine, self.admission), opening = yield* settlements.inspect(String(row.position), { asOf: String(row.openedAt), knownAt: String(row.createdAt) }, ctx), position = yield* settlements.inspect(String(row.position), { asOf: at, ...(knownAt ? { knownAt } : {}) }, ctx);
   if (!opening.overdue) return yield* fail('Collection requires an overdue materialized position at opening');
   const ageDays = position.overdue ? Math.floor((Date.parse(at) - Date.parse(String(position.dueAt))) / 86400000) : 0;
   const stage = !position.overdue ? toMinor(String(position.remaining), 6) === 0n ? toMinor(String(position.materialized), 6) > 0n ? 'cured' : 'void' : 'current' : ageDays >= Number(policy.escalationDays) ? 'escalate' : ageDays >= Number(policy.warningDays) ? 'warning' : 'overdue';
   return { row, policy, activity, position, ageDays, stage };
  });
 }
 notice(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CollectionNotice.get', { id }, ctx), notice = yield* self.read('notifications', 'Notification', row.notification, ctx), state = yield* self.state(String(row.collection), String(notice.at), ctx), subscription = yield* self.read('notifications', 'NotificationSubscription', notice.subscription, ctx), member = yield* self.read('participation', 'Participation', subscription.recipient, ctx);
   if (member.participant !== state.position.debtor) return yield* fail('Collection notice recipient is not the debtor');
   if (row.interaction && !state.activity.events.some(e => e.id === row.interaction)) return yield* fail('Collection interaction is not admitted in the case');
   const outcome = yield* new Notifications(self.engine).outcome(String(notice.id), ctx);
   return { row, state, outcome };
  });
 }
 promise(id: string, instant: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const at = yield* Effect.try({ try: () => decodeDatetime(instant), catch: () => err('ValidationFailed', 'Invalid promise instant') }), row = yield* self.call('PaymentPromise.get', { id }, ctx), baseline = yield* self.state(String(row.collection), String(row.at), ctx, String(row.createdAt)), current = yield* self.state(String(row.collection), at, ctx);
   if (at < String(row.at) || row.unit !== baseline.position.unit || toMinor(String(row.amount), 6) > toMinor(String(baseline.position.remaining), 6)) return yield* fail('Promise exceeds outstanding debt or has wrong unit');
   const arrangement = yield* new AgreementCatalog(self.engine).state(String(row.arrangement), String(row.at), ctx), approval = yield* new Decisions(self.engine).state(String(row.approval), ctx);
   if (arrangement.phase !== 'Active' || arrangement.agreement.customer !== baseline.position.debtor || arrangement.agreement.supplier !== baseline.position.creditor || String(arrangement.agreement.validUntil) < String(row.dueAt) || approval.outcome?.selected !== row.accepted || String(approval.terminal?.createdAt) > String(row.at)) return yield* fail('Promise needs issued arrangement and accepted approval for these counterparties');
   if (row.challenge) { const mapping = yield* self.read('trust', 'TrustPartySubject', row.partySubject, ctx); if (mapping.party !== baseline.position.debtor) return yield* fail('Challenge principal is not the debtor'); const challenge = yield* new Challenges(self.engine).assurance(String(row.challenge), String(row.subject), ctx); if (!challenge.value) return yield* fail('Payment arrangement challenge is not satisfied'); }
   yield* self.support(row.support, ctx);
   const delta = toMinor(String(current.position.settled), 6) - toMinor(String(baseline.position.settled), 6), paid = delta > 0n ? delta : 0n;
   return { row, baseline, current, paid: formatMinor(paid, 6), status: paid >= toMinor(String(row.amount), 6) || current.stage === 'cured' ? 'kept' : at >= String(row.dueAt) ? 'broken' : 'pending' };
  });
 }
 dispute(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CollectionDispute.get', { id }, ctx), state = yield* self.state(String(row.collection), at, ctx), dispute = yield* new Disputes(self.engine).inspect(String(row.dispute), ctx), representation = yield* self.read('billing', 'BillPosition', row.billPosition, ctx);
   if (!dispute.contested.charge || dispute.row.appellant !== state.position.debtor) return yield* fail('Collections dispute must contest a debtor charge');
   const claim = yield* findTerminalFact(self.engine, '@forgegraph/foundation/billing/_/BilledCharge', 'charge', dispute.contested.charge, ctx), bill = yield* new Billing(self.engine, self.admission).positions(String(representation.bill), at, ctx);
   if (!claim || claim.bill !== representation.bill || !bill.some((position: Wire) => position.position === state.row.position)) return yield* fail('Dispute does not contest this billed position');
   return { row, state, dispute };
  });
 }
 disposition(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CollectionDisposition.get', { id }, ctx), state = yield* self.state(String(row.collection), String(row.at), ctx), evaluation = yield* new Evaluations(self.engine).result(String(row.evaluation), ctx), approval = yield* new Decisions(self.engine).state(String(row.approval), ctx);
   yield* self.read('specification', 'SpecificationPin', row.policy, ctx); yield* self.support(row.support, ctx);
   if (String(evaluation.finishedAt) < String(state.row.openedAt) || approval.outcome?.selected !== row.accepted || String(approval.terminal?.createdAt) < String(evaluation.finishedAt) || String(approval.terminal?.createdAt) > String(row.at)) return yield* fail('Disposition requires accepted evaluation');
   if (row.posting) { const posting = yield* new Ledger(self.engine).inspect(String(row.posting), ctx); if (posting.reversedBy || String(posting.fact.createdAt) > String(row.at)) return yield* fail('Writeoff posting is reversed or not yet published'); }
   if (row.recovery) { const work = yield* new Fulfillments(self.engine).status(String(row.recovery), ctx); if (work.phase !== 'completed' || work.coverage !== 'complete' || String(work.end!.endedAt) > String(row.at)) return yield* fail('External recovery handoff is incomplete'); }
   if (!self.dispositionAdmission) return yield* fail('Financial/recovery profile admission is required');
   yield* self.dispositionAdmission(row, state.position, ctx);
   return { row, state };
  });
 }
 closure(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CollectionClosure.get', { id }, ctx), event = yield* self.read('case-management', 'CaseEvent', row.closure, ctx), historical = yield* self.state(String(row.collection), String(event.at), ctx, String(row.createdAt)), current = yield* self.state(String(row.collection), at, ctx);
   if (!historical.activity.events.some(e => e.id === event.id)) return yield* fail('Closure is not admitted in case history');
   if (row.kind === 'cured' && (toMinor(String(historical.position.remaining), 6) !== 0n || toMinor(String(historical.position.materialized), 6) <= 0n)) return yield* fail('Cure requires a fully settled materialized position');
   if (row.disposition) yield* self.disposition(String(row.disposition), ctx);
   return { row, historical, current, effective: Date.parse(at) >= Date.parse(String(event.at)) && current.activity.closed && current.activity.head === event.id && (row.kind !== 'cured' || current.stage === 'cured') };
  });
 }
}
