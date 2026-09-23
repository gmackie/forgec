import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Deliveries } from './delivery.js';
import { Storage } from '../services.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/notifications/_/';
const m = '@forgegraph/foundation/participation/_/';
export class Notifications {
  constructor(private readonly engine: Engine) {}
  private recover(effect: Effect.Effect<Wire, ForgeError>, resource: string, field: string, value: string, expected: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return effect.pipe(Effect.catch(error => error.code === 'UniqueConflict' ? Effect.gen(function* () {
      const existing = yield* findTerminalFact(self.engine, resource, field, value, ctx);
      if (!existing) return yield* Effect.fail(error);
      if (Object.entries(expected).some(([key, input]) => key === 'at' ? Date.parse(String(existing[key])) !== Date.parse(String(input)) : existing[key] !== input)) return yield* Effect.fail(err('IdempotencyMismatch', 'Notification identity reused with different input'));
      return existing;
    }) : Effect.fail(error)));
  }
  /** The explicitly selected immutable preference is the dispatch policy snapshot.
   * Later changes apply to future snapshots and do not cancel existing notices. */
  create(input: { key: string; subscription: string; preference: string; at: string; content?: string; template?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.subscription(input.subscription, input.at, ctx);
      yield* self.engine.call(p + 'NotificationPreference.get', { id: input.preference }, ctx);
      for (const id of [input.content, input.template]) if (id) yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id }, ctx);
      const body={ ...input, content: input.content ?? null, template: input.template ?? null };
      return yield* self.recover(self.engine.call(p + 'Notification.create', body, { ...ctx, idempotencyKey: ctx.idempotencyKey ?? input.key }),p+'Notification','key',input.key,body,ctx);
    });
  }
  private subscription(id: string, at: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const subscription = yield* self.engine.call(p + 'NotificationSubscription.get', { id }, ctx);
      yield* self.engine.call(p + 'NotificationTopic.get', { id: subscription.topic }, ctx);
      const endpoint = yield* self.engine.call(p + 'NotificationEndpointLink.get', { id: subscription.endpoint }, ctx);
      yield* self.engine.call('@forgegraph/foundation/delivery/_/DeliveryDestination.get', { id: endpoint.destination }, ctx);
      const member = yield* self.engine.call(m + 'Participation.get', { id: subscription.recipient }, ctx);
      const end = yield* findTerminalFact(self.engine, m + 'ParticipationEnd', 'participation', member.id, ctx);
      const instant = Date.parse(at);
      if (!Number.isFinite(instant) || instant < Date.parse(String(member.validFrom)) || member.validUntil != null && instant >= Date.parse(String(member.validUntil)) || end && instant >= Date.parse(String(end.effectiveAt))) return yield* Effect.fail(err('ValidationFailed', 'Recipient participation is not active at notification time'));
      return { ...subscription, destination: endpoint.destination };
    });
  }
  /** A page of visible subscriptions; exhaust the cursor for a complete visible audience. */
  audience(topic: string, ctx: CallContext, page: { cursor?: string; limit?: number } = {}) {
    return this.engine.call(p + 'NotificationSubscription.list.byTopic', { params: { topic }, ...page }, ctx);
  }
  dispatch(notification: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const notice = yield* self.engine.call(p + 'Notification.get', { id: notification }, ctx);
      const subscription = yield* self.subscription(String(notice.subscription), String(notice.at), ctx);
      const preference = yield* self.engine.call(p + 'NotificationPreference.get', { id: notice.preference }, ctx);
      if (preference.subscription !== notice.subscription) return yield* Effect.fail(err('ValidationFailed', 'Preference belongs to another subscription'));
      for (const id of [notice.content, notice.template]) if (id != null) yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id }, ctx);
      const stableKey = 'notification:' + createHash('sha256').update(notification).digest('hex');
      if (!preference.enabled) {const body={notification,preference:preference.id,reason:preference.reason};return yield* self.recover(self.engine.call(p+'NotificationSuppression.create',body,{...ctx,idempotencyKey:stableKey}),p+'NotificationSuppression','notification',notification,body,ctx);}
      const intentInput={key:stableKey,destination:String(subscription.destination),...(notice.content==null?{}:{payload:String(notice.content)}),maxAttempts:3};
      const intent = yield* self.recover(new Deliveries(self.engine).create(intentInput,{...ctx,idempotencyKey:stableKey}),'@forgegraph/foundation/delivery/_/DeliveryIntent','key',stableKey,{...intentInput,payload:notice.content??null},ctx);
      const body={notification,preference:preference.id,endpoint:subscription.endpoint,subscription:subscription.id,intent:intent.id};
      return yield* self.recover(self.engine.call(p+'NotificationDeliveryLink.create',body,{...ctx,idempotencyKey:stableKey}),p+'NotificationDeliveryLink','notification',notification,body,ctx);
    });
  }
  outcome(notification: string, ctx: CallContext): Effect.Effect<{ status: string; intent: string | null }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const notice = yield* self.engine.call(p + 'Notification.get', { id: notification }, ctx);
      yield* self.subscription(String(notice.subscription), String(notice.at), ctx);
      yield* self.engine.call(p + 'NotificationPreference.get', { id: notice.preference }, ctx);
      for (const id of [notice.content, notice.template]) if (id != null) yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id }, ctx);
      const suppressed = yield* findTerminalFact(self.engine, p + 'NotificationSuppression', 'notification', notification, ctx);
      if (suppressed) return { status: 'Suppressed', intent: null };
      const link = yield* findTerminalFact(self.engine, p + 'NotificationDeliveryLink', 'notification', notification, ctx);
      if (!link) return { status: 'Pending', intent: null };
      yield* self.engine.call('@forgegraph/foundation/delivery/_/DeliveryIntent.get', { id: link.intent }, ctx);
      const resource = self.engine.model.resource('@forgegraph/foundation/delivery/_/DeliveryStep');
      const unique = resource.uniques.find(u => u.fields.includes('number'))!;
      const storage = yield* Storage;
      let step: Wire | null = null;
      for (let number = 1; number <= 33; number++) {
        const values = { intent: link.intent, number };
        const row = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
        if (!row) break;
        step = yield* self.engine.call(resource.id + '.get', { id: row.id }, ctx);
      }
      return { status: step ? yield* new Deliveries(self.engine).outcome(String(step.id), ctx) : 'Dispatched', intent: String(link.intent) };
    }).pipe(Effect.provide(self.engine.layer));
  }
}
