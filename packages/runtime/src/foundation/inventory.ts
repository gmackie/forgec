import { Effect } from 'effect';
import type { Engine, CallContext, AtomicMutation } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, decodeDecimal, formatMinor, toMinor } from '../codecs.js';
import { Storage } from '../services.js';
import { err, type ForgeError } from '../errors.js';
import { Allocations } from './allocation.js';
import { Evidence } from './evidence.js';
import { Demands } from './demand.js';
const p = '@forgegraph/foundation/inventory/_/', a = '@forgegraph/foundation/allocation/_/';
const fail = (message: string) => err('ValidationFailed', message);
export type InventoryAction = 'receipt' | 'issue' | 'transfer' | 'returned' | 'reserve' | 'release' | 'reconcile';
interface StockState { item: Wire; specification: Wire; events: Wire[]; balances: Map<string, bigint>; held: Map<string, { position: string; quantity: bigint }>; seen: Set<string> }
export interface InventoryCommand { item: string; previous: string | null; key: string; kind: InventoryAction; at: string; position: string; destination?: string; quantity: string; reservation?: string; count?: string; source: string }
export class Inventory {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const seal = yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get', { id }, ctx);
   yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
  });
 }
 private positionRow(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('InventoryPosition.get', { id }, ctx);
   yield* self.engine.call('@forgegraph/foundation/place/_/Place.get', { id: row.place }, ctx);
   yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id: row.custodian }, ctx);
   const pool = yield* self.engine.call(a + 'AllocationPool.get', { id: row.pool }, ctx);
   return { row, pool };
  });
 }
 private apply(state: StockState, event: Wire, ctx: CallContext, checkAllocation = true): Effect.Effect<void, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const { row: position, pool } = yield* self.positionRow(event.position, ctx);
   if (position.item !== state.item.id || pool.unit !== state.specification.unit) return yield* Effect.fail(fail('Stock position unit or item mismatch'));
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: event.source }, ctx);
   const quantity = toMinor(String(event.quantity), 6), id = String(position.id);
   if (quantity <= 0n || state.item.kind === 'serialized' && quantity !== 1_000_000n) return yield* Effect.fail(fail('Invalid stock quantity for identity kind'));
   const balance = state.balances.get(id) ?? 0n;
   const held = () => [...state.held.values()].filter(r => r.position === id).reduce((n, r) => n + r.quantity, 0n);
   if (event.kind === 'reserve' || event.kind === 'release' || event.kind === 'issue' && event.reservation) {
    const reservation = yield* self.call('InventoryReservation.get', { id: event.reservation }, ctx);
    const claim = yield* new Allocations(self.engine).reservation(String(reservation.allocation), ctx);
    if (reservation.position !== id || claim.row.pool !== position.pool || toMinor(String(claim.row.quantity), 6) !== quantity || claim.row.unit !== state.specification.unit) return yield* Effect.fail(fail('Stock reservation does not match allocation'));
    if (reservation.demand) {
     const demand = yield* new Demands(self.engine).state(String(reservation.demand), ctx);
     if (!checkAllocation && event.kind === 'reserve' && ['cancelled', 'superseded'].includes(demand.phase)) return yield* Effect.fail(fail('Resolved demand cannot reserve stock'));
     if (demand.row.specification !== state.specification.definition || demand.row.unit !== state.specification.unit || toMinor(String(demand.row.quantity), 6) !== quantity) return yield* Effect.fail(fail('Demand does not match stock reservation'));
    }
    if (checkAllocation && !claim.history.some(h => h.commandKey === 'inventory:' + String(event.key) && h.action === (event.kind === 'reserve' ? 'book' : 'release'))) return yield* Effect.fail(fail('Stock event lacks matching Allocation publication'));
    const rid = String(reservation.id);
    if (event.kind === 'reserve') {
     if (state.seen.has(rid) || position.condition !== 'usable' || quantity > balance - held()) return yield* Effect.fail(fail('Stock is unavailable or reservation was already used'));
     state.seen.add(rid); state.held.set(rid, { position: id, quantity });
    } else {
     const prior = state.held.get(rid);
     if (!prior || prior.position !== id || prior.quantity !== quantity) return yield* Effect.fail(fail('Release requires the full active stock reservation'));
     state.held.delete(rid);
     if (event.kind === 'issue') {
      if (position.condition !== 'usable') return yield* Effect.fail(fail('Only usable stock may be issued'));
      state.balances.set(id, balance - quantity);
     }
    }
   } else if (event.kind === 'receipt' || event.kind === 'returned') {
    if (event.kind === 'returned' && position.condition !== 'returned') return yield* Effect.fail(fail('Returns must enter a returned-condition position'));
    state.balances.set(id, balance + quantity);
   } else if (event.kind === 'issue' || event.kind === 'transfer') {
    if (quantity > balance - held()) return yield* Effect.fail(fail('Movement exceeds unreserved stock'));
    if (event.kind === 'issue' && position.condition !== 'usable') return yield* Effect.fail(fail('Only usable stock may be issued'));
    state.balances.set(id, balance - quantity);
    if (event.kind === 'transfer') {
     const { row: destination, pool: targetPool } = yield* self.positionRow(event.destination, ctx);
     if (destination.item !== state.item.id || destination.id === id || targetPool.unit !== state.specification.unit) return yield* Effect.fail(fail('Transfer destination is incompatible'));
     const target = String(destination.id);
     state.balances.set(target, (state.balances.get(target) ?? 0n) + quantity);
    }
   } else if (event.kind === 'reconcile') {
    const count = yield* self.call('InventoryCount.get', { id: event.count }, ctx);
    yield* self.support(count.evidence, ctx);
    const counted = toMinor(String(count.quantity), 6), difference = counted - balance;
    if (count.position !== id || String(count.at) < String(state.events.at(-1)?.at ?? '') || (difference < 0n ? -difference : difference) !== quantity || counted < held()) return yield* Effect.fail(fail('Count is stale, inconsistent or below reserved stock'));
    state.balances.set(id, counted);
   } else return yield* Effect.fail(fail('Unknown inventory action'));
   if (state.item.kind === 'serialized' && [...state.balances.values()].reduce((n, q) => n + q, 0n) > 1_000_000n) return yield* Effect.fail(fail('Serialized resource cannot occupy multiple positions'));
  });
 }
 private read(item: string, ctx: CallContext): Effect.Effect<StockState, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('StockItem.get', { id: item }, ctx);
   const specification = yield* self.call('StockItemSpecification.get', { id: row.specification }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: specification.definition }, ctx);
   yield* self.engine.call('@forgegraph/foundation/identifiers/_/IdentifierSet.get', { id: row.identifiers }, ctx);
   if (row.serial) yield* self.engine.call('@forgegraph/foundation/resource-relations/_/ResourceSubject.get', { id: row.serial }, ctx);
   const state: StockState = { item: row, specification, events: [], balances: new Map(), held: new Map(), seen: new Set() };
   const resource = self.engine.model.resource(p + 'InventoryMovement'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage;
   for (let ordinal = 1; ordinal <= 256; ordinal++) {
    const values = { item, ordinal }, found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
    if (!found) break;
    const event = yield* self.call('InventoryMovement.get', { id: found.id }, ctx);
    if ((event.previous ?? null) !== (state.events.at(-1)?.id ?? null)) return yield* Effect.fail(fail('Inventory journal is not consecutive'));
    yield* self.apply(state, event, ctx); state.events.push(event);
   }
   return state;
  }).pipe(Effect.provide(self.engine.layer));
 }
 position(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const { row } = yield* self.positionRow(id, ctx), state = yield* self.read(String(row.item), ctx);
   const onHand = state.balances.get(id) ?? 0n, reserved = [...state.held.values()].filter(r => r.position === id).reduce((n, r) => n + r.quantity, 0n);
   const available = row.condition === 'usable' ? onHand - reserved : 0n, gap = toMinor(String(row.reorderPoint), 6) - available;
   return { row, unit: String(state.specification.unit), onHand: formatMinor(onHand, 6), reserved: formatMinor(reserved, 6), available: formatMinor(available, 6), reorderGap: formatMinor(gap > 0n ? gap : 0n, 6), head: state.events.at(-1)?.id ?? null, events: state.events };
  });
 }
 move(input: InventoryCommand, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const state = yield* self.read(input.item, ctx);
   if ((state.events.at(-1)?.id ?? null) !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Inventory journal changed'));
   const at = yield* Effect.try({ try: () => decodeDatetime(input.at), catch: () => fail('Invalid stock occurrence time') });
   const quantity = yield* Effect.try({ try: () => decodeDecimal(input.quantity, { scale: 6 }), catch: () => fail('Invalid stock quantity') });
   const event = { ...input, at, quantity, ordinal: state.events.length + 1, destination: input.destination ?? null, reservation: input.reservation ?? null, count: input.count ?? null };
   yield* self.apply(state, event, ctx, false);
   const mutations: AtomicMutation[] = [];
   if (input.kind === 'reserve' || input.kind === 'release' || input.kind === 'issue' && input.reservation) {
    const reservation = yield* self.call('InventoryReservation.get', { id: input.reservation }, ctx);
    const allocation = yield* new Allocations(self.engine).prepare([{ reservation: String(reservation.allocation), action: input.kind === 'reserve' ? 'book' : 'release', commandKey: 'inventory:' + input.key }], ctx);
    if (allocation.existing.length) return yield* Effect.fail(fail('Allocation command was previously published without this stock event'));
    mutations.push(...allocation.mutations);
   }
   mutations.push({ operation: p + 'InventoryMovement.create', input: event });
   return (yield* self.engine.atomic(mutations, ctx)).at(-1)!;
  });
 }
 reorder(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('InventoryReorder.get', { id }, ctx), position = yield* self.position(String(row.position), ctx);
   const item = yield* self.call('StockItem.get', { id: position.row.item }, ctx), specification = yield* self.call('StockItemSpecification.get', { id: item.specification }, ctx);
   const demand = yield* new Demands(self.engine).state(String(row.demand), ctx);
   if (demand.row.specification !== specification.definition || demand.row.unit !== specification.unit || demand.row.place !== position.row.place) return yield* Effect.fail(fail('Reorder demand must match item specification, unit and place'));
   return { position, demand, gap: position.reorderGap };
  });
 }
 visibility(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('InventoryVisibility.get', { id }, ctx), movement = yield* self.call('InventoryMovement.get', { id: row.movement }, ctx);
   const state = yield* self.read(String(movement.item), ctx);
   if (!state.events.some(e => e.id === movement.id)) return yield* Effect.fail(fail('Visibility requires admitted movement'));
   if (row.related) yield* self.call('StockItem.get', { id: row.related }, ctx);
   if (row.transaction) yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.transaction }, ctx);
   yield* self.support(row.evidence, ctx);
   return { row, movement };
  });
 }
}
