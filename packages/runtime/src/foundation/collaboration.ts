import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Storage } from '../services.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/collaboration/_/';
const membershipPrefix = '@forgegraph/foundation/participation/_/';
export type ThreadEventKind = 'Entry' | 'Reaction' | 'Mention' | 'Attachment' | 'Close' | 'Reopen';
export interface ThreadActivity { events: Wire[]; closed: boolean; head: string | null }
/** Candidate facts become visible activity only through the guarded thread journal. */
export class Collaborations {
  constructor(private readonly engine: Engine) {}
  private participant(id: string, at: string, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const participant = yield* self.engine.call(p + 'ThreadParticipant.get', { id }, ctx);
      const member = yield* self.engine.call(membershipPrefix + 'Participation.get', { id: participant.membership }, ctx);
      const instant = Date.parse(at);
      const end = yield* findTerminalFact(self.engine, membershipPrefix + 'ParticipationEnd', 'participation', member.id, ctx);
      if (!Number.isFinite(instant) || instant < Date.parse(String(member.validFrom)) || member.validUntil != null && instant >= Date.parse(String(member.validUntil)) || end && instant >= Date.parse(String(end.effectiveAt)))
        return yield* Effect.fail(err('ValidationFailed', 'Participation is not active at the activity instant'));
    });
  }
  activity(thread: string, ctx: CallContext): Effect.Effect<ThreadActivity, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(p + 'Thread.get', { id: thread }, ctx);
      const resource = self.engine.model.resource(p + 'ThreadEvent');
      const unique = resource.uniques.find(u => u.fields.includes('sequence'))!;
      const storage = yield* Storage, events: Wire[] = [], published = new Set<string>();
      for (let sequence = 1; sequence <= 128; sequence++) {
        const values = { thread, sequence };
        const found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
        if (!found) break;
        const event = yield* self.engine.call(resource.id + '.get', { id: found.id }, ctx);
        yield* self.participant(String(event.actor), String(event.at), ctx);
        if (event.entry != null) {
          const entry = yield* self.engine.call(p + 'ThreadEntry.get', { id: event.entry }, ctx);
          if (entry.corrects != null && !published.has(String(entry.corrects))) return yield* Effect.fail(err('ValidationFailed', 'Correction must refer to published activity'));
          published.add(String(entry.id));
        }
        for (const [field, type] of [['reaction', 'Reaction'], ['mention', 'Mention'], ['attachment', 'AttachmentLink']] as const) {
          if (event[field] == null) continue;
          const detail = yield* self.engine.call(p + type + '.get', { id: event[field] }, ctx);
          if (!published.has(String(detail.entry))) return yield* Effect.fail(err('ValidationFailed', 'Activity refers to an unpublished entry'));
          if (field === 'mention') yield* self.participant(String(detail.participant), String(event.at), ctx);
          if (field === 'attachment') yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id: detail.revision }, ctx);
        }
        events.push(event);
      }
      const last = events.at(-1);
      return { events, closed: last?.closed === true, head: last == null ? null : String(last.id) };
    }).pipe(Effect.provide(self.engine.layer));
  }
  publish(input: { thread: string; actor: string; kind: ThreadEventKind; at: string; previous: string | null; fact?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.activity(input.thread, ctx);
      const priorIndex = input.previous == null ? -1 : state.events.findIndex(e => e.id === input.previous);
      if (input.previous != null && priorIndex < 0 || state.head !== input.previous && !ctx.idempotencyKey) return yield* Effect.fail(err('VersionConflict', 'Thread journal changed'));
      const sequence = priorIndex + 2;
      yield* self.participant(input.actor, input.at, ctx);
      const field = ({ Entry: 'entry', Reaction: 'reaction', Mention: 'mention', Attachment: 'attachment' } as Record<string, string>)[input.kind];
      const type = ({ Entry: 'ThreadEntry', Reaction: 'Reaction', Mention: 'Mention', Attachment: 'AttachmentLink' } as Record<string, string>)[input.kind];
      if (type) {
        const detail = yield* self.engine.call(p + type + '.get', { id: input.fact }, ctx);
        const target = input.kind === 'Entry' ? detail.corrects : detail.entry;
        if (target != null && !state.events.slice(0, sequence - 1).some(e => e.entry === target)) return yield* Effect.fail(err('ValidationFailed', 'Target entry has not been published'));
        if (input.kind === 'Mention') yield* self.participant(String(detail.participant), input.at, ctx);
        if (input.kind === 'Attachment') yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id: detail.revision }, ctx);
      }
      return yield* self.engine.call(p + 'ThreadEvent.create', {
        thread: input.thread, actor: input.actor, kind: input.kind, at: input.at, previous: input.previous,
        sequence, closed: input.kind === 'Close',
        entry: null, reaction: null, mention: null, attachment: null, ...(field ? { [field]: input.fact } : {}),
      }, ctx);
    });
  }
}
