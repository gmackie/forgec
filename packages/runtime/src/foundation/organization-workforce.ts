import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Storage } from '../services.js';
import { Qualifications } from './qualification.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/organization-workforce/_/';
export interface WorkforceState { events: Wire[]; appointments: Wire[]; endings: Map<string, string> }
export class Workforces {
  constructor(private readonly engine: Engine) {}
  private eligible(incumbency: Wire, at: string, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const position = yield* self.engine.call(p + 'Position.get', { id: incumbency.position }, ctx);
      const unit = yield* self.engine.call(p + 'OrganizationUnit.get', { id: position.unit }, ctx);
      if (unit.place != null) yield* self.engine.call('@forgegraph/foundation/place/_/Place.get', { id: unit.place }, ctx);
      if (unit.classification != null) yield* self.engine.call('@forgegraph/foundation/classification/_/ConceptRevision.get', { id: unit.classification }, ctx);
      const specification = yield* self.engine.call(p + 'PositionSpecification.get', { id: position.specification }, ctx);
      yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: specification.pin }, ctx);
      const member = yield* self.engine.call('@forgegraph/foundation/participation/_/Participation.get', { id: incumbency.membership }, ctx);
      const end = yield* findTerminalFact(self.engine, '@forgegraph/foundation/participation/_/ParticipationEnd', 'participation', member.id, ctx);
      const instant = Date.parse(at);
      if (!Number.isFinite(instant) || instant < Date.parse(String(member.validFrom)) || member.validUntil != null && instant >= Date.parse(String(member.validUntil)) || end && instant >= Date.parse(String(end.effectiveAt))) return yield* Effect.fail(err('ValidationFailed', 'Incumbent membership is inactive'));
      const subject = yield* self.engine.call('@forgegraph/foundation/qualification/_/PartySubject.get', { id: incumbency.partySubject }, ctx);
      if (specification.requirement != null && !(yield* new Qualifications(self.engine).satisfies(String(subject.subject), String(specification.requirement), at, ctx)).qualified) return yield* Effect.fail(err('ValidationFailed', 'Incumbent does not satisfy the position requirement'));
    });
  }
  state(position: string, ctx: CallContext): Effect.Effect<WorkforceState, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(p + 'Position.get', { id: position }, ctx);
      const resource = self.engine.model.resource(p + 'IncumbencyEvent'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!;
      const storage = yield* Storage, events: Wire[] = [], appointments: Wire[] = [], endings = new Map<string, string>();
      for (let ordinal = 1; ordinal <= 128; ordinal++) {
        const values = { position, ordinal };
        const row = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
        if (!row) break;
        const event = yield* self.engine.call(resource.id + '.get', { id: row.id }, ctx);
        const candidate = yield* self.engine.call(p + 'Incumbency.get', { id: event.incumbency }, ctx);
        if (event.action === 'End') {
          if (!appointments.some(a => a.id === candidate.id) || endings.has(String(candidate.id))) return yield* Effect.fail(err('ValidationFailed', 'Invalid incumbent termination'));
          endings.set(String(candidate.id), String(event.at));
        } else {
          if (appointments.some(a => a.id === candidate.id)) return yield* Effect.fail(err('ValidationFailed', 'Duplicate incumbency publication'));
          for (const old of appointments) {
            const until = endings.get(String(old.id)) ?? String(old.until);
            if (Date.parse(String(candidate.from)) < Date.parse(until) && Date.parse(String(candidate.until)) > Date.parse(String(old.from))) return yield* Effect.fail(err('ValidationFailed', 'Exclusive position incumbencies overlap'));
          }
          appointments.push(candidate);
        }
        events.push(event);
      }
      return { events, appointments, endings };
    }).pipe(Effect.provide(self.engine.layer));
  }
  publish(incumbency: string, action: 'Appoint' | 'End', at: string, previous: string | null, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const candidate = yield* self.engine.call(p + 'Incumbency.get', { id: incumbency }, ctx);
      const state = yield* self.state(String(candidate.position), ctx);
      if ((state.events.at(-1)?.id ?? null) !== previous) return yield* Effect.fail(err('VersionConflict', 'Incumbency journal changed'));
      if (action === 'Appoint') {
        yield* self.eligible(candidate, at, ctx);
        if (state.appointments.some(a => a.id === incumbency)) return yield* Effect.fail(err('ValidationFailed', 'Incumbency was already published'));
        for (const old of state.appointments) {
          const until = state.endings.get(String(old.id)) ?? String(old.until);
          if (Date.parse(String(candidate.from)) < Date.parse(until) && Date.parse(String(candidate.until)) > Date.parse(String(old.from))) return yield* Effect.fail(err('ValidationFailed', 'Position is occupied'));
        }
      } else if (!state.appointments.some(a => a.id === incumbency) || state.endings.has(incumbency)) return yield* Effect.fail(err('ValidationFailed', 'Incumbency is not active'));
      return yield* self.engine.call(p + 'IncumbencyEvent.create', { position: candidate.position, incumbency, action, at, previous, ordinal: state.events.length + 1 }, ctx);
    });
  }
  at(position: string, at: string, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = Date.parse(at);
      if (!Number.isFinite(instant)) return yield* Effect.fail(err('ValidationFailed', 'Invalid incumbency instant'));
      const state = yield* self.state(position, ctx);
      for (const appointment of state.appointments) {
        const end = state.endings.get(String(appointment.id)) ?? String(appointment.until);
        if (instant >= Date.parse(String(appointment.from)) && instant < Date.parse(end)) { yield* self.eligible(appointment, at, ctx); return appointment; }
      }
      return null;
    });
  }
}
