import { Effect } from "effect";
import type { Engine, CallContext, AtomicMutation } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import type { Wire } from "../decode.js";
import { decodeDatetime, decodeDecimal } from "../codecs.js";
import { Availability } from "./availability.js";
import { Allocations, type AllocationCommand } from "./allocation.js";
import { findTerminalFact } from "./facts.js";
const p = "@forgegraph/foundation/scheduling/_/", a = "@forgegraph/foundation/allocation/_/", part = "@forgegraph/foundation/participation/_/";
const bad = (message: string) => Effect.fail(err("ValidationFailed", message));
export interface SchedulingNeedInput { pool: string; calendar: string; quantity: string; participant?: string }
export interface SchedulingRequirementInput { key: string; durationMinutes: number; participants: string; place: string; needs: SchedulingNeedInput[] }
export interface BookingInput { key: string; slot: string; fulfillment: string; predecessor?: string }
/** Scheduling owns bounded slot selection and appointment publication; Allocation
 * owns capacity and Availability owns recurrence. Staging is inert, publication
 * and every involved pool guard commit together using Engine.atomic. */
export class Scheduling {
  private readonly availability: Availability;
  private readonly allocation: Allocations;
  constructor(private readonly engine: Engine) { this.availability = new Availability(engine); this.allocation = new Allocations(engine); }
  private call(op: string, body: Wire, ctx: CallContext): Effect.Effect<Wire, ForgeError> { return this.engine.call(p + op, body, ctx); }
  private clean(ctx: CallContext) { const { idempotencyKey: _key, ...context } = ctx; return context; }
  requirement(input: SchedulingRequirementInput, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (!input.needs.length || input.needs.length > 16 || new Set(input.needs.map(n => n.pool)).size !== input.needs.length) return yield* bad("Requirement needs 1..16 distinct pools");
      let head: string | null = null;
      for (const need of [...input.needs].reverse()) {
        const quantity = yield* Effect.try({try:()=>decodeDecimal(need.quantity, {scale:6,min:"0.000001"}),catch:()=>err("ValidationFailed","Invalid required quantity")});
        const row: Wire = yield* self.call("SchedulingNeed.create", { ...need, quantity, participant: need.participant ?? null, next: head }, self.clean(ctx));
        head = String(row.id);
      }
      return yield* self.call("SchedulingRequirement.create", { key: input.key, durationMinutes: input.durationMinutes, participants: input.participants, place: input.place, head }, self.clean(ctx));
    });
  }
  private needs(requirement: Wire, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.engine.call(part + "ParticipationSet.get", { id: requirement.participants }, ctx);
      yield* self.engine.call("@forgegraph/foundation/place/_/Place.get", { id: requirement.place }, ctx);
      const needs: Wire[] = [], pools = new Set<string>(), seen = new Set<string>();
      let id = String(requirement.head);
      while (id) {
        if (needs.length >= 16 || seen.has(id)) return yield* bad("Scheduling requirements exceed bounded chain");
        seen.add(id);
        const need = yield* self.call("SchedulingNeed.get", { id }, ctx);
        if (pools.has(String(need.pool))) return yield* bad("Duplicate required pool");
        pools.add(String(need.pool));
        yield* self.engine.call(a + "AllocationPool.get", { id: need.pool }, ctx);
        if (need.participant != null) {
          const member = yield* self.engine.call(part + "Participation.get", { id: need.participant }, ctx);
          if (member.participationSet !== requirement.participants) return yield* bad("Participant is outside requirement set");
          yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: member.participant }, ctx);
          yield* self.engine.call(part + "ParticipationRole.get", { id: member.role }, ctx);
        }
        needs.push(need); id = need.next == null ? "" : String(need.next);
      }
      return needs;
    });
  }
  private membership(needs: Wire[], from: string, until: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      for (const need of needs) if (need.participant != null) {
        const member = yield* self.engine.call(part + "Participation.get", { id: need.participant }, ctx);
        const end = yield* findTerminalFact(self.engine, part + "ParticipationEnd", "participation", need.participant, ctx);
        if (String(member.validFrom) > from || member.validUntil != null && String(member.validUntil) < until || end && String(end.effectiveAt) < until) return yield* bad("Participant does not cover the complete appointment");
      }
    });
  }
  search(requirement: string, from: string, until: string, ctx: CallContext): Effect.Effect<{ from: string; until: string }[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const req = yield* self.call("SchedulingRequirement.get", { id: requirement }, ctx), needs = yield* self.needs(req, ctx);
      let windows = yield* Effect.try({try:()=>[{ from: decodeDatetime(from), until: decodeDatetime(until) }],catch:()=>err("ValidationFailed","Invalid search interval")});
      for (const need of needs) {
        const available = yield* self.availability.effectiveWindows(String(need.calendar), from, until, ctx);
        windows = windows.flatMap(x => available.windows.flatMap(y => {
          const start = x.from > y.from ? x.from : y.from, end = x.until < y.until ? x.until : y.until;
          return start < end ? [{from:start,until:end}] : [];
        }));
      }
      return windows.filter(w => Date.parse(w.until) - Date.parse(w.from) >= Number(req.durationMinutes) * 60000);
    });
  }
  slot(requirement: string, from: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const req = yield* self.call("SchedulingRequirement.get", { id: requirement }, ctx);
      const start = yield* Effect.try({try:()=>decodeDatetime(from),catch:()=>err("ValidationFailed","Invalid slot instant")});
      const until = new Date(Date.parse(start) + Number(req.durationMinutes) * 60000).toISOString();
      if (!(yield* self.search(requirement, start, until, ctx)).length) return yield* bad("Slot is outside calendar intersection");
      yield* self.membership(yield* self.needs(req, ctx), start, until, ctx);
      return yield* self.call("CandidateSlot.create", { requirement, from: start, until }, self.clean(ctx));
    });
  }
  private slotNeeds(slot: Wire, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const req = yield* self.call("SchedulingRequirement.get", { id: slot.requirement }, ctx), needs = yield* self.needs(req, ctx);
      if (Date.parse(String(slot.until)) - Date.parse(String(slot.from)) !== Number(req.durationMinutes) * 60000 || !(yield* self.search(String(req.id), String(slot.from), String(slot.until), ctx)).length) return yield* bad("Invalid candidate slot");
      yield* self.membership(needs, String(slot.from), String(slot.until), ctx);
      return needs;
    });
  }
  private members(appointment: Wire, commit: Wire, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const rows: Wire[] = [], seen = new Set<string>(); let id = String(commit.head);
      while (id) {
        if (seen.has(id) || rows.length >= 16) return yield* bad("Appointment reservation chain invalid");
        seen.add(id);
        const node = yield* self.call("AppointmentReservation.get", { id }, ctx);
        if (node.appointment !== appointment.id) return yield* bad("Foreign appointment reservation");
        rows.push(yield* self.engine.call(a + "AllocationReservation.get", { id: node.reservation }, ctx));
        id = node.next == null ? "" : String(node.next);
      }
      const slot = yield* self.call("CandidateSlot.get", { id: appointment.slot }, ctx);
      const req = yield* self.call("SchedulingRequirement.get", { id: slot.requirement }, ctx), needs = yield* self.needs(req, ctx);
      if (Date.parse(String(slot.until)) - Date.parse(String(slot.from)) !== Number(req.durationMinutes) * 60000 || !(yield* self.search(String(req.id), String(slot.from), String(slot.until), ctx)).length) return yield* bad("Invalid published candidate slot");
      if (rows.length !== needs.length || new Set(rows.map(r => r.pool)).size !== rows.length) return yield* bad("Partial appointment publication");
      for (const row of rows) {
        const need = needs.find(n => n.pool === row.pool);
        if (!need || need.quantity !== row.quantity || row.from !== slot.from || row.until !== slot.until) return yield* bad("Appointment reservation does not match required slot");
      }
      return rows;
    });
  }
  inspect(appointment: string, ctx: CallContext): Effect.Effect<{ appointment: Wire; commit: Wire | null; end: Wire | null; reservations: Wire[] }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.call("Appointment.get", { id: appointment }, ctx);
      yield* self.engine.call("@forgegraph/foundation/fulfillment/_/FulfillmentSet.get", { id: row.fulfillment }, ctx);
      const commit = yield* findTerminalFact(self.engine, p + "AppointmentCommit", "appointment", appointment, ctx);
      const end = yield* findTerminalFact(self.engine, p + "AppointmentEnd", "appointment", appointment, ctx);
      if (!commit) {
        if (end) return yield* bad("Unpublished appointment has terminal state");
        return { appointment: row, commit, end, reservations: [] };
      }
      const reservations = yield* self.members(row, commit, ctx);
      let priorReservations: Wire[] = [];
      if (row.predecessor != null) {
        const prior = yield* self.call("Appointment.get", {id:row.predecessor},ctx);
        const priorCommit = yield* findTerminalFact(self.engine,p+"AppointmentCommit","appointment",prior.id,ctx);
        const priorEnd = yield* findTerminalFact(self.engine,p+"AppointmentEnd","appointment",prior.id,ctx);
        if (!priorCommit || !priorEnd || priorEnd.replacement !== row.id) return yield* bad("Replacement lacks prior terminal publication");
        priorReservations = yield* self.members(prior,priorCommit,ctx);
      }
      if (end?.replacement != null) {
        const successor = yield* self.call("Appointment.get",{id:end.replacement},ctx);
        if (successor.predecessor !== row.id || !(yield* findTerminalFact(self.engine,p+"AppointmentCommit","appointment",successor.id,ctx))) return yield* bad("Reschedule terminal lacks replacement publication");
      }
      for (const reservation of reservations) {
        const state = yield* self.allocation.reservation(String(reservation.id), ctx);
        const publication = state.history.find(entry => entry.commandKey === "appointment:" + appointment && (entry.action === "book" && entry.reservation === reservation.id || entry.action === "replace" && entry.replacement === reservation.id));
        if (!publication) return yield* bad("Reservation lacks appointment publication evidence");
        const old = priorReservations.find(r => r.pool === reservation.pool);
        if (old ? publication.action !== "replace" || publication.reservation !== old.id : publication.action !== "book") return yield* bad("Reservation does not replace the predecessor claim");
        if (end && !state.history.some(entry => entry.commandKey === (end.replacement == null ? "cancel:" + appointment : "appointment:" + end.replacement) && entry.reservation === reservation.id && ["release", "replace"].includes(String(entry.action)))) return yield* bad("Appointment terminal lacks pool release evidence");
        if (state.phase !== (end ? "released" : "allocated")) return yield* bad("Appointment allocation authority disagrees with publication");
      }
      return { appointment: row, commit, end, reservations };
    });
  }
  book(input: BookingInput, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const context = self.clean(ctx), body = { key: input.key, slot: input.slot, fulfillment: input.fulfillment, predecessor: input.predecessor ?? null };
      let appointment = yield* findTerminalFact(self.engine, p + "Appointment", "key", input.key, ctx);
      if (!appointment) appointment = yield* self.call("Appointment.create", body, context).pipe(Effect.catch(error => error.code === "UniqueConflict" ? findTerminalFact(self.engine, p + "Appointment", "key", input.key, ctx).pipe(Effect.flatMap(row => row ? Effect.succeed(row) : Effect.fail(error))) : Effect.fail(error)));
      if (appointment.slot !== input.slot || appointment.fulfillment !== input.fulfillment || (appointment.predecessor ?? null) !== (input.predecessor ?? null)) return yield* Effect.fail(err("IdempotencyMismatch", "Appointment key reused"));
      const current = yield* self.inspect(String(appointment.id), ctx);
      if (current.commit) return appointment;
      const slot = yield* self.call("CandidateSlot.get", { id: input.slot }, ctx), needs = yield* self.slotNeeds(slot, ctx);
      const prior = input.predecessor ? yield* self.inspect(input.predecessor, ctx) : null;
      if (prior && (!prior.commit || prior.end || prior.appointment.id === appointment.id)) return yield* bad("Prior appointment is not active");
      let head: string | null = null; const reservations: Wire[] = [];
      for (const need of [...needs].reverse()) {
        const pool = yield* self.engine.call(a + "AllocationPool.get", { id: need.pool }, ctx);
        const reservation: Wire = yield* self.engine.call(a + "AllocationReservation.create", { pool: need.pool, key: String(appointment.id) + ":" + String(need.pool), quantity: need.quantity, unit: pool.unit, from: slot.from, until: slot.until, holdUntil: slot.until }, context).pipe(Effect.catch(error => error.code === "UniqueConflict" ? self.engine.call(a + "AllocationReservation.find.byPoolKey", { params: {pool: need.pool, key:String(appointment.id) + ":" + String(need.pool)} }, ctx) : Effect.fail(error)));
        if (reservation.quantity !== need.quantity || reservation.from !== slot.from || reservation.until !== slot.until) return yield* bad("Conflicting durable reservation candidate");
        reservations.push(reservation);
        const node: Wire = yield* self.call("AppointmentReservation.create", { appointment: appointment.id, reservation: reservation.id, next: head }, context);
        head = String(node.id);
      }
      const commands: AllocationCommand[] = reservations.map(row => {
        const old = prior?.reservations.find(r => r.pool === row.pool);
        return old ? { reservation:String(old.id), replacement:String(row.id), action:"replace", commandKey:"appointment:" + appointment!.id } : { reservation:String(row.id), action:"book", commandKey:"appointment:" + appointment!.id };
      });
      for (const old of prior?.reservations ?? []) if (!reservations.some(r => r.pool === old.pool)) commands.push({ reservation:String(old.id), action:"release", commandKey:"appointment:" + appointment.id });
      if (commands.length > 16) return yield* bad("Reschedule union exceeds 16 pools");
      for (let retry = 0; retry < 16; retry++) {
        const raced = yield* self.inspect(String(appointment.id), ctx);
        if (raced.commit) return appointment;
        if (prior && (yield* self.inspect(String(prior.appointment.id), ctx)).end) return yield* bad("Prior appointment already ended");
        const batch = yield* self.allocation.prepare(commands, ctx);
        if (batch.existing.length) {
          if ((yield* self.inspect(String(appointment.id), ctx)).commit) return appointment;
          return yield* bad("Pool claims exist without appointment publication");
        }
        const mutations: AtomicMutation[] = [...batch.mutations, { operation: p + "AppointmentCommit.create", input: {appointment:appointment.id,head} }];
        if (prior) mutations.push({operation:p+"AppointmentEnd.create",input:{appointment:prior.appointment.id,replacement:appointment.id,reason:"Rescheduled"}});
        const committed = yield* self.engine.atomic(mutations, context).pipe(Effect.as(true), Effect.catch(error => error.code === "UniqueConflict" ? Effect.succeed(false) : Effect.fail(error)));
        if (committed) { yield* self.inspect(String(appointment.id), ctx); return appointment; }
      }
      return yield* Effect.fail(err("TransientConflict", "Scheduling contention"));
    }).pipe(Effect.catch(error => {
      if (!["UniqueConflict", "TransientConflict", "ValidationFailed"].includes(error.code)) return Effect.fail(error);
      return Effect.gen(function* () {
        const row = yield* findTerminalFact(self.engine,p+"Appointment","key",input.key,ctx);
        if (!row || row.slot !== input.slot || row.fulfillment !== input.fulfillment || (row.predecessor ?? null) !== (input.predecessor ?? null)) return yield* Effect.fail(error);
        const state = yield* self.inspect(String(row.id),ctx);
        return state.commit ? row : yield* Effect.fail(error);
      });
    }));
  }
  cancel(appointment: string, reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      for (let retry = 0; retry < 16; retry++) {
        const state = yield* self.inspect(appointment, ctx);
        if (!state.commit) return yield* bad("Cannot cancel unpublished appointment");
        if (state.end) {
          if (state.end.replacement != null || state.end.reason !== reason) return yield* Effect.fail(err("IdempotencyMismatch", "Appointment already ended differently"));
          return state.end;
        }
        const batch = yield* self.allocation.prepare(state.reservations.map(r => ({reservation:String(r.id),action:"release",commandKey:"cancel:"+appointment})), ctx);
        if (batch.existing.length) return yield* bad("Pool releases exist without cancellation");
        const result = yield* self.engine.atomic([...batch.mutations,{operation:p+"AppointmentEnd.create",input:{appointment,replacement:null,reason}}],self.clean(ctx)).pipe(Effect.map(rows => rows.at(-1)!),Effect.catch(error => error.code === "UniqueConflict" ? Effect.succeed(null) : Effect.fail(error)));
        if (result) { yield* self.inspect(appointment, ctx); return result; }
      }
      return yield* Effect.fail(err("TransientConflict", "Scheduling cancellation contention"));
    }).pipe(Effect.catch(error => {
      if (!["UniqueConflict", "TransientConflict", "ValidationFailed"].includes(error.code)) return Effect.fail(error);
      return Effect.gen(function* () {
        const state = yield* self.inspect(appointment,ctx);
        return state.end && state.end.replacement == null && state.end.reason === reason ? state.end : yield* Effect.fail(error);
      });
    }));
  }
}
