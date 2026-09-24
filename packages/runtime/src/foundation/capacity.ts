import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, formatMinor, toMinor } from '../codecs.js';
import { err, type ForgeError } from '../errors.js';
import { Qualifications } from './qualification.js';
import { Availability } from './availability.js';
import { Allocations } from './allocation.js';
import { Demands } from './demand.js';
const p = '@forgegraph/foundation/capacity/_/';
export interface CapacityProjection {
 capacity: string; basis: string; unit: string; at: string;
 amount: string; available: string; committed: string; remaining: string;
 demanded: string; unapplied: string; gap: string;
 qualified: boolean; temporallyAvailable: boolean; allocationHead: unknown;
}
/** Business capacity projections. Allocation alone arbitrates reservation ownership. */
export class Capacities {
 constructor(private readonly engine: Engine) {}
 project(capacity: string, at: string, ctx: CallContext): Effect.Effect<CapacityProjection, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const instant = yield* Effect.try({ try: () => decodeDatetime(at), catch: () => err('ValidationFailed', 'Invalid capacity instant') });
   const row = yield* self.engine.call(p + 'Capacity.get', { id: capacity }, ctx);
   if (instant < String(row.from) || instant >= String(row.until)) return yield* Effect.fail(err('ValidationFailed', 'Instant is outside the capacity interval'));
   const provider = yield* self.engine.call(p + 'CapabilityProvider.get', { id: row.provider }, ctx);
   const capability = yield* self.engine.call(p + 'CapabilitySpecification.get', { id: row.capability }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: capability.definition }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.scope }, ctx);
   if (provider.resource) yield* self.engine.call('@forgegraph/foundation/resource-relations/_/ResourceSubject.get', { id: provider.resource }, ctx);
   if (row.place) yield* self.engine.call('@forgegraph/foundation/place/_/Place.get', { id: row.place }, ctx);
   const qualification = yield* new Qualifications(self.engine).satisfies(String(provider.subject), String(capability.requirement), instant, ctx);
   const end = new Date(Date.parse(instant) + 60_000).toISOString();
   const windows = yield* new Availability(self.engine).effectiveWindows(String(provider.calendar), instant, end, ctx);
   const temporallyAvailable = windows.windows.some(w => w.from <= instant && w.until >= end);
   const allocation = yield* new Allocations(self.engine).inspect(String(row.pool), instant, ctx);
   const pool = yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationPool.get', { id: row.pool }, ctx);
   const active = new Set(allocation.claims.map(c => c.reservation));
   const amount = toMinor(String(row.amount), 6);
   const available = qualification.qualified && temporallyAvailable ? amount : 0n;
   const committed = toMinor(String(pool.capacity), 6) - toMinor(allocation.available, 6);
   let demanded = 0n, unapplied = 0n, cursor: string | undefined;
   const ordinals = new Set<number>();
   do {
    const page = yield* self.engine.call(p + 'CapacityDemand.list.byCapacity', { params: { capacity }, limit: 16, ...(cursor ? { cursor } : {}) }, ctx);
    for (const application of page.items as Wire[]) {
     const ordinal = Number(application.ordinal);
     if (ordinals.size >= 16 || ordinals.has(ordinal) || ordinal < 1 || ordinal > Number(row.applicationCount)) return yield* Effect.fail(err('ValidationFailed', 'Invalid capacity application membership'));
     ordinals.add(ordinal);
     const demand = yield* new Demands(self.engine).state(String(application.demand), ctx);
     if (application.reservation) yield* self.engine.call('@forgegraph/foundation/allocation/_/AllocationReservation.get', { id: application.reservation }, ctx);
     if (demand.phase === 'cancelled' || demand.phase === 'superseded' || instant < String(demand.row.from) || instant >= String(demand.row.until)) continue;
     const quantity = toMinor(String(demand.row.quantity), 6);
     demanded += quantity;
     if (!application.reservation || !active.has(String(application.reservation))) unapplied += quantity;
    }
    cursor = page.next == null ? undefined : String(page.next);
   } while (cursor);
   if (ordinals.size !== row.applicationCount) return yield* Effect.fail(err('ValidationFailed', 'Capacity applications are incomplete or unreadable'));
   const remaining = available - committed;
   const shortage = unapplied - remaining;
   return { capacity, basis: String(row.basis), unit: String(row.unit), at: instant, amount: formatMinor(amount, 6), available: formatMinor(available, 6), committed: formatMinor(committed, 6), remaining: formatMinor(remaining, 6), demanded: formatMinor(demanded, 6), unapplied: formatMinor(unapplied, 6), gap: formatMinor(shortage > 0n ? shortage : 0n, 6), qualified: qualification.qualified, temporallyAvailable, allocationHead: allocation.head };
  });
 }
 compare(planned: string, actual: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const a = yield* self.engine.call(p + 'Capacity.get', { id: planned }, ctx);
   const b = yield* self.engine.call(p + 'Capacity.get', { id: actual }, ctx);
   if (!['planned', 'forecast'].includes(String(a.basis)) || b.basis !== 'actual' || ['provider', 'capability', 'unit', 'scope', 'place', 'from', 'until'].some(k => a[k] !== b[k])) return yield* Effect.fail(err('ValidationFailed', 'Capacity comparison requires compatible planned/forecast and actual intervals'));
   const expected = yield* self.project(planned, at, ctx), observed = yield* self.project(actual, at, ctx);
   return { expected, observed, variance: formatMinor(toMinor(observed.amount, 6) - toMinor(expected.amount, 6), 6) };
  });
 }
}
