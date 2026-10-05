import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, toMinor } from '../codecs.js';
import { Storage } from '../services.js';
import { err, type ForgeError } from '../errors.js';
const p = '@forgegraph/foundation/composition/_/';
const bad = (message: string) => err('ValidationFailed', message);
export interface CompositionView { instance: Wire; revision: Wire | null; members: Wire[]; children: CompositionView[]; cycle: boolean }
export class Compositions {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private complete(type: string, field: string, id: unknown, count: number, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   let cursor: string | undefined; const rows: Wire[] = [];
   do {
    const page = yield* self.call(type + '.list.by' + field[0]!.toUpperCase() + field.slice(1), { params: { [field]: id }, limit: 16, ...(cursor ? { cursor } : {}) }, ctx);
    rows.push(...page.items as Wire[]);
    if (rows.length > 16) return yield* Effect.fail(bad('Composition membership exceeds its bound'));
    cursor = page.next == null ? undefined : String(page.next);
   } while (cursor);
   rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
   if (rows.length !== count || rows.some((r, i) => Number(r.ordinal) !== i + 1)) return yield* Effect.fail(bad('Composition membership is incomplete or unreadable'));
   return rows;
  });
 }
 private spec(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('CompositionSpecification.get', { id }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.definition }, ctx);
   const slots = yield* self.complete('CompositionSlot', 'specification', id, Number(row.slotCount), ctx);
   const allowed = new Map<string, Set<string>>();
   for (const slot of slots) {
    const alternatives = yield* self.complete('CompositionAlternative', 'slot', slot.id, Number(slot.alternativeCount), ctx);
    const choices = new Set([String(slot.component)]);
    for (const alternative of alternatives) {
     yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: alternative.authority }, ctx);
     choices.add(String(alternative.component));
    }
    allowed.set(String(slot.id), choices);
   }
   return { row, slots, allowed };
  });
 }
 specification(id: string, ctx: CallContext) {
  const self = this; let nodes = 0;
  function visit(current: string, path: Map<string, boolean>): Effect.Effect<void, ForgeError> {
   return Effect.gen(function* () {
    if (++nodes > 128 || path.size > 16) return yield* Effect.fail(bad('Specification graph exceeds its traversal bound'));
    if (path.has(current)) {
     if ([...path.values()].some(v => !v)) return yield* Effect.fail(bad('Specification cycle is forbidden by its profile'));
     return;
    }
    const spec = yield* self.spec(current, ctx), next = new Map(path).set(current, spec.row.allowCycles === true);
    for (const choices of spec.allowed.values()) for (const child of choices) yield* visit(child, next);
   });
  }
  return Effect.gen(function* () { yield* visit(id, new Map()); return yield* self.spec(id, ctx); });
 }
 private history(instance: string, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const resource = self.engine.model.resource(p + 'CompositionRevision'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage, rows: Wire[] = [];
   for (let ordinal = 1; ordinal <= 64; ordinal++) {
    const values = { instance, ordinal }, found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
    if (!found) break;
    const row = yield* self.call('CompositionRevision.get', { id: found.id }, ctx);
    if ((row.previous ?? null) !== (rows.at(-1)?.id ?? null)) return yield* Effect.fail(bad('Composition history is not consecutive'));
    rows.push(row);
   }
   return rows;
  }).pipe(Effect.provide(self.engine.layer));
 }
 private inspect(instance: string, at: string, ctx: CallContext, candidate?: Wire): Effect.Effect<CompositionView, ForgeError> {
  const self = this; let nodes = 0;
  function visit(id: string, path: Map<string, boolean>): Effect.Effect<CompositionView, ForgeError> {
   return Effect.gen(function* () {
    if (++nodes > 128 || path.size > 16) return yield* Effect.fail(bad('Instance graph exceeds its traversal bound'));
    const row = yield* self.call('CompositionInstance.get', { id }, ctx);
    if (row.resource) yield* self.engine.call('@forgegraph/foundation/resource-relations/_/ResourceSubject.get', { id: row.resource }, ctx);
    const spec = yield* self.spec(String(row.specification), ctx);
    if (path.has(id)) {
     if (!spec.row.allowCycles || [...path.values()].some(v => !v)) return yield* Effect.fail(bad('Instance cycle is forbidden by its profile'));
     return { instance: row, revision: null, members: [], children: [], cycle: true };
    }
    const history = yield* self.history(id, ctx);
    const revision = candidate?.instance === id ? candidate : history.filter(r => String(r.from) <= at).at(-1) ?? null;
    if (!revision) {
     if (spec.slots.length || history.length) return yield* Effect.fail(bad('Instance has no effective composition revision'));
     return { instance: row, revision: null, members: [], children: [], cycle: false };
    }
    if (String(revision.from) > at || revision.until && at >= String(revision.until)) return yield* Effect.fail(bad('Composition revision is not effective'));
    const set = yield* self.call('CompositionSet.get', { id: revision.set }, ctx);
    if (set.instance !== id) return yield* Effect.fail(bad('Component set belongs to another instance'));
    const members = yield* self.complete('CompositionMember', 'set', set.id, Number(set.componentCount), ctx);
    const groups = new Map<string, Wire[]>(), children: CompositionView[] = []; let priorOrdinal = 0;
    const next = new Map(path).set(id, spec.row.allowCycles === true);
    for (const member of members) {
     const slot = spec.slots.find(s => s.id === member.slot);
     if (!slot || String(slot.from) > at || slot.until && at >= String(slot.until)) return yield* Effect.fail(bad('Component uses a foreign or ineffective slot'));
     if (spec.row.ordered && Number(slot.ordinal) < priorOrdinal) return yield* Effect.fail(bad('Components violate specification order'));
     priorOrdinal = Number(slot.ordinal);
     const child = yield* visit(String(member.child), next);
     if (!spec.allowed.get(String(slot.id))!.has(String(child.instance.specification))) return yield* Effect.fail(bad('Component does not conform to a permitted specification/substitution'));
     groups.set(String(slot.id), [...groups.get(String(slot.id)) ?? [], member]); children.push(child);
    }
    for (const slot of spec.slots) {
     if (String(slot.from) > at || slot.until && at >= String(slot.until)) continue;
     const group = groups.get(String(slot.id)) ?? [], quantity = group.reduce((n, m) => n + toMinor(String(m.quantity), 6), 0n);
     if (group.length < Number(slot.minimumCount) || group.length > Number(slot.maximumCount) || group.length && (quantity < toMinor(String(slot.minimumQuantity), 6) || quantity > toMinor(String(slot.maximumQuantity), 6))) return yield* Effect.fail(bad('Component cardinality or quantity violates its slot'));
    }
    return { instance: row, revision, members, children, cycle: false };
   });
  }
  return visit(instance, new Map());
 }
 conform(instance: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const instant = yield* Effect.try({ try: () => decodeDatetime(at), catch: () => bad('Invalid composition instant') });
   const row = yield* self.call('CompositionInstance.get', { id: instance }, ctx);
   yield* self.specification(String(row.specification), ctx);
   return yield* self.inspect(instance, instant, ctx);
  });
 }
 publish(input: { instance: string; set: string; previous: string | null; from: string; until?: string; reason: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const rows = yield* self.history(input.instance, ctx);
   if ((rows.at(-1)?.id ?? null) !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Composition revision changed'));
   const from = yield* Effect.try({ try: () => decodeDatetime(input.from), catch: () => bad('Invalid composition effectivity') });
   const until = input.until == null ? null : yield* Effect.try({ try: () => decodeDatetime(input.until!), catch: () => bad('Invalid composition expiry') });
   const candidate = { ...input, from, until, ordinal: rows.length + 1 };
   const row = yield* self.call('CompositionInstance.get', { id: input.instance }, ctx);
   yield* self.specification(String(row.specification), ctx);
   yield* self.inspect(input.instance, from, ctx, candidate);
   return yield* self.call('CompositionRevision.create', candidate, ctx);
  });
 }
}
