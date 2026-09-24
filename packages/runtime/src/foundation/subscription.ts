import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { Storage } from '../services.js';
import { decodeDatetime } from '../codecs.js';
import { err } from '../errors.js';
import { AgreementCatalog } from './agreement-catalog.js';
import { Decisions } from './decision.js';
import { Evidence } from './evidence.js';
import { Quotas } from './quota.js';
import { ServiceLevels } from './service-level.js';
import { Billing } from './billing.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/subscription/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
export class Subscriptions {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(pkg: string, type: string, id: unknown, ctx: CallContext) { return this.engine.call('@forgegraph/foundation/' + pkg + '/_/' + type + '.get', { id }, ctx); }
 private term(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('SubscriptionTerm.get', { id }, ctx), agreement = yield* new AgreementCatalog(self.engine).state(String(row.agreement), String(row.from), ctx), right = yield* self.read('agreement-catalog', 'AgreementEntitlementLink', row.right, ctx), entitlement = yield* self.read('entitlement', 'Entitlement', row.entitlement, ctx), consent = yield* new Decisions(self.engine).state(String(row.consent), ctx);
   if (agreement.phase !== 'Active' || agreement.issuance?.right !== right.id || consent.outcome?.selected !== row.accepted || String(consent.terminal?.createdAt) > String(row.from)) return yield* fail('Term requires issued agreement rights and accepted consent before its start');
   yield* self.read('billing', 'BillingPeriod', row.billing, ctx);
   if (row.allowance) { const allowance = yield* self.read('quota', 'Allowance', row.allowance, ctx); if (String(allowance.validFrom) > String(row.from) || String(allowance.validUntil) < String(row.until)) return yield* fail('Allowance must cover the term'); }
   if (row.serviceLevel) yield* self.read('service-level', 'ServiceLevelInstance', row.serviceLevel, ctx);
   return { row, entitlement };
  });
 }
 private history(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('Subscription.get', { id }, ctx); yield* self.read('party', 'Party', row.customer, ctx); yield* self.read('specification', 'SpecificationPin', row.policy, ctx);
   const events: Wire[] = [], resource = self.engine.model.resource(p + 'SubscriptionEvent'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage;
   for (let ordinal = 1; ordinal <= 128; ordinal++) {
    const values = { subscription: id, ordinal }, found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
    if (!found) break;
    const event = yield* self.call('SubscriptionEvent.get', { id: found.id }, ctx);
    if ((event.previous ?? null) !== (events.at(-1)?.id ?? null)) return yield* fail('Subscription history is not consecutive');
    yield* self.validate(event, events.at(-1) ?? null, ctx);
    events.push(event);
   }
   return { row, events, head: events.at(-1)?.id ?? null };
  }).pipe(Effect.provide(self.engine.layer));
 }
 private validate(event: Wire, previous: Wire | null, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const term = yield* self.term(String(event.term), ctx), seal = yield* self.read('evidence', 'EvidenceSeal', event.support, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
   if (event.kind !== 'cancel' && (String(event.effectiveAt) < String(term.row.from) || String(event.effectiveAt) >= String(term.row.until))) return yield* fail('Transition falls outside the selected term');
   if (previous && ['renew', 'change'].includes(String(event.kind))) {
    const prior = yield* self.term(String(previous.term), ctx);
    if (previous.phase !== 'active' || event.kind === 'renew' && term.row.from !== prior.row.until || event.kind === 'change' && (String(term.row.from) < String(prior.row.from) || String(term.row.from) >= String(prior.row.until))) return yield* fail('Renewal must be contiguous; change must occur inside an active term');
    if (term.entitlement.holder !== prior.entitlement.holder || term.entitlement.scope !== prior.entitlement.scope || term.entitlement.right !== prior.entitlement.right) return yield* fail('Term changes must preserve customer, scope and right continuity');
    if (term.row.agreement !== prior.row.agreement) { const agreement = yield* self.read('agreement-catalog', 'Agreement', term.row.agreement, ctx); if (agreement.predecessor !== prior.row.agreement) return yield* fail('Replacement agreement must explicitly succeed the prior agreement'); }
   }
  });
 }
 act(input: { subscription: string; previous: string | null; term: string; kind: 'start' | 'renew' | 'change' | 'suspend' | 'resume' | 'cancel'; effectiveAt: string; reason: string; support: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const state = yield* self.history(input.subscription, ctx);
   if (state.head !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Subscription journal changed'));
   const at = yield* Effect.try({ try: () => decodeDatetime(input.effectiveAt), catch: () => err('ValidationFailed', 'Invalid effective instant') });
   const event = { ...input, effectiveAt: at, ordinal: state.events.length + 1, phase: input.kind === 'cancel' ? 'cancelled' : input.kind === 'suspend' ? 'suspended' : 'active' };
   yield* self.validate(event, state.events.at(-1) ?? null, ctx);
   return yield* self.call('SubscriptionEvent.create', event, ctx);
  });
 }
 state(id: string, instant: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const at = yield* Effect.try({ try: () => decodeDatetime(instant), catch: () => err('ValidationFailed', 'Invalid subscription instant') }), history = yield* self.history(id, ctx), event = history.events.filter(e => String(e.effectiveAt) <= at).at(-1);
   if (!event) return { ...history, phase: 'pending', effective: false, term: null, quota: null, serviceLevel: null };
   const term = yield* self.term(String(event.term), ctx), agreement = yield* new AgreementCatalog(self.engine).state(String(term.row.agreement), at, ctx), end = yield* findTerminalFact(self.engine, '@forgegraph/foundation/entitlement/_/EntitlementEnd', 'entitlement', term.entitlement.id, ctx);
   const phase = event.phase === 'cancelled' ? 'cancelled' : at >= String(term.row.until) ? 'expired' : event.phase === 'suspended' ? Date.parse(at) < Date.parse(String(event.effectiveAt)) + Number(history.row.graceSeconds) * 1000 ? 'grace' : 'suspended' : 'active';
   const effective = ['active', 'grace'].includes(phase) && agreement.phase === 'Active' && !(end && String(end.effectiveAt) <= at);
   const quota = effective && term.row.allowance ? yield* new Quotas(self.engine).inspect(String(term.row.allowance), at, ctx) : null;
   const serviceLevel = effective && term.row.serviceLevel ? yield* new ServiceLevels(self.engine).state(String(term.row.serviceLevel), at, ctx) : null;
   return { ...history, phase, effective, term: term.row, quota, serviceLevel };
  });
 }
 proration(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('SubscriptionProration.get', { id }, ctx), event = yield* self.call('SubscriptionEvent.get', { id: row.transition }, ctx), history = yield* self.history(String(event.subscription), ctx);
   if (!history.events.some(e => e.id === event.id)) return yield* fail('Proration transition is not admitted');
   const term = yield* self.term(String(event.term), ctx), previous = event.previous ? yield* self.call('SubscriptionEvent.get', { id: event.previous }, ctx) : null, prior = previous ? yield* self.term(String(previous.term), ctx) : term;
   const charge = yield* self.read('billing', 'BillingCharge', row.charge, ctx), period = yield* self.read('billing', 'BillingPeriod', charge.period, ctx), original = yield* self.read('billing', 'BillingCharge', charge.adjustmentFor, ctx), originalPeriod = yield* self.read('billing', 'BillingPeriod', original.period, ctx);
   if (![term.row.agreement, prior.row.agreement].includes(period.agreement) || originalPeriod.agreement !== prior.row.agreement || String(charge.ratedAt) < String(event.effectiveAt)) return yield* fail('Proration must adjust prior agreement billing after the transition');
   yield* self.read('specification', 'SpecificationPin', row.policy, ctx);
   const claim = yield* findTerminalFact(self.engine, '@forgegraph/foundation/billing/_/BilledCharge', 'charge', charge.id, ctx);
   if (!claim || !(yield* new Billing(self.engine).inspect(String(claim.bill), ctx)).issue) return yield* fail('Proration adjustment is not issued');
   return { row, charge, event };
  });
 }
}
