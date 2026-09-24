import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { Storage } from '../services.js';
import { err, type ForgeError } from '../errors.js';
import { Evidence } from './evidence.js';
import { AgreementCatalog } from './agreement-catalog.js';
import { Notifications } from './notifications.js';
import { Collaborations } from './collaboration.js';
import { Measurements } from './measurement.js';
import { Budgets } from './planning-budget.js';
import { Scheduling } from './scheduling.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/campaign/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
/** A host must evaluate the pinned audience selector and channel policy at the notice instant.
 * Returning true is an explicit domain assertion, not interpretation of SpecificationPin text. */
export type CampaignAdmission = (audience: Wire, route: Wire, subscription: Wire, at: string, ctx: CallContext) => Effect.Effect<boolean, ForgeError>;
export class Campaigns {
 constructor(private readonly engine: Engine, private readonly admit: CampaignAdmission) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(pkg: string, type: string, id: unknown, ctx: CallContext) { return this.engine.call('@forgegraph/foundation/' + pkg + '/_/' + type + '.get', { id }, ctx); }
 private indexed(type: string, values: Wire, field: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const resource = self.engine.model.resource(p + type), unique = resource.uniques.find(u => u.fields.includes(field))!, storage = yield* Storage;
   const row = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
   return row ? yield* self.call(type + '.get', { id: row.id }, ctx) : null;
  }).pipe(Effect.provide(self.engine.layer));
 }
 state(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('Campaign.get', { id }, ctx), audience = yield* self.call('CampaignAudience.get', { id: row.audience }, ctx);
   yield* self.read('specification', 'SpecificationPin', audience.selector, ctx);
   yield* self.read('notifications', 'NotificationTopic', audience.topic, ctx);
   yield* self.read('specification', 'SpecificationPin', row.channel, ctx);
   yield* self.read('planning-budget', 'Plan', row.plan, ctx);
   yield* self.read('planning-budget', 'Goal', row.objective, ctx);
   yield* self.read('measurement', 'MetricSubject', row.metricSubject, ctx);
   if (row.content) yield* self.read('artifact', 'ArtifactRevision', row.content, ctx);
   if (row.offer) {
    const offer = yield* new AgreementCatalog(self.engine).offer(String(row.offer), ctx);
    yield* self.read('specification', 'SpecificationPin', offer.terms, ctx);
    if (String(offer.validFrom) > String(row.from) || String(offer.validUntil) < String(row.until)) return yield* fail('Offer must cover the campaign schedule');
   }
   const budget = row.budget ? yield* new Budgets(self.engine).state(String(row.budget), ctx) : null;
   const events: Wire[] = [];
   for (let ordinal = 1; ordinal <= 128; ordinal++) {
    const event = yield* self.indexed('CampaignEvent', { campaign: id, ordinal }, 'ordinal', ctx);
    if (!event) break;
    if ((event.previous ?? null) !== (events.at(-1)?.id ?? null)) return yield* fail('Campaign journal is not consecutive');
    events.push(event);
   }
   return { row, audience, budget, events, head: events.at(-1)?.id ?? null, phase: events.at(-1)?.phase ?? 'draft' };
  });
 }
 private batch(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CampaignWave.get', { id }, ctx), campaign = yield* self.state(String(row.campaign), ctx);
   if (row.appointment) {
    const appointment = yield* new Scheduling(self.engine).inspect(String(row.appointment), ctx);
    const slot = yield* self.read('scheduling', 'CandidateSlot', appointment.appointment.slot, ctx);
    if (!appointment.commit || appointment.end || String(slot.from) > String(row.from) || String(slot.until) < String(row.until)) return yield* fail('Wave requires a live appointment covering its schedule');
   }
   const members: Wire[] = [];
   for (let ordinal = 1; ordinal <= Number(row.memberCount); ordinal++) {
    const member = yield* self.indexed('CampaignMember', { wave: id, ordinal }, 'ordinal', ctx);
    if (!member) return yield* fail('Wave member set is incomplete');
    const notice = yield* self.read('notifications', 'Notification', member.notification, ctx), subscription = yield* self.read('notifications', 'NotificationSubscription', notice.subscription, ctx), preference = yield* self.read('notifications', 'NotificationPreference', notice.preference, ctx), route = yield* self.call('CampaignRoute.get', { id: member.route }, ctx);
    const end = yield* findTerminalFact(self.engine, p + 'CampaignRouteEnd', 'route', route.id, ctx);
    if (subscription.topic !== campaign.audience.topic || subscription.endpoint !== route.endpoint || route.channel !== campaign.row.channel || !preference.enabled || notice.content !== campaign.row.content || String(route.from) > String(notice.at) || String(route.until) <= String(notice.at) || end && String(end.at) <= String(notice.at)) return yield* fail('Wave recipient, content, preference or reachability mismatch');
    const seal = yield* self.read('evidence', 'EvidenceSeal', route.support, ctx);
    yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    yield* new Notifications(self.engine).outcome(String(notice.id), ctx);
    if (!(yield* self.admit(campaign.audience, route, subscription, String(notice.at), ctx))) return yield* fail('Host rejected audience or channel admission');
    members.push(member);
   }
   return { row, campaign, members };
  });
 }
 act(input: { campaign: string; previous: string | null; kind: 'activate' | 'pause' | 'resume' | 'wave' | 'close'; at: string; wave?: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const state = yield* self.state(input.campaign, ctx);
   if (state.head !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Campaign journal changed'));
   if ((input.kind === 'wave') !== !!input.wave) return yield* fail('Only wave admission takes a wave');
   if (input.wave) yield* self.batch(input.wave, ctx);
   return yield* self.call('CampaignEvent.create', { ...input, wave: input.wave ?? null, ordinal: state.events.length + 1, phase: input.kind === 'close' ? 'closed' : input.kind === 'pause' ? 'paused' : 'active' }, ctx);
  });
 }
 /** Admission is a durable snapshot. Pause stops new waves; it does not cancel admitted deliveries.
  * Hosts call this before dispatch; no external messages are sent by this service. */
 wave(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const batch = yield* self.batch(id, ctx);
   if (!batch.campaign.events.some(e => e.wave === id)) return yield* fail('Wave is not admitted');
   return batch;
  });
 }
 response(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CampaignResponse.get', { id }, ctx), member = yield* self.call('CampaignMember.get', { id: row.member }, ctx), wave = yield* self.wave(String(member.wave), ctx);
   const event = yield* self.read('collaboration', 'ThreadEvent', row.interaction, ctx), actor = yield* self.read('collaboration', 'ThreadParticipant', event.actor, ctx), notice = yield* self.read('notifications', 'Notification', member.notification, ctx), subscription = yield* self.read('notifications', 'NotificationSubscription', notice.subscription, ctx);
   const activity = yield* new Collaborations(self.engine).activity(String(event.thread), ctx);
   if (!activity.events.some(e => e.id === event.id) || actor.membership !== subscription.recipient || String(event.at) < String(notice.at)) return yield* fail('Response requires admitted interaction by this recipient after outreach');
   yield* self.read('specification', 'SpecificationPin', row.attribution, ctx);
   return { row, wave, event };
  });
 }
 performance(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CampaignPerformance.get', { id }, ctx), campaign = yield* self.state(String(row.campaign), ctx), assessment = yield* new Measurements(self.engine).assessment(String(row.assessment), ctx);
   return { row, campaign, assessment };
  });
 }
}
