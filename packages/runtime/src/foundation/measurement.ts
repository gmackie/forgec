import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, formatMinor, toMinor } from '../codecs.js';
import { err, type ForgeError } from '../errors.js';
import { Evidence } from './evidence.js';
import { Evaluations } from './evaluation.js';
const p = '@forgegraph/foundation/measurement/_/', s = '@forgegraph/foundation/specification/_/', e = '@forgegraph/foundation/evidence/_/';
const bad = (message: string) => err('ValidationFailed', message);
interface VerifiedObservation { row: Wire; metric: Wire; leaves: Set<string>; samples: bigint }
const divide = (numerator: bigint, denominator: bigint) => {
 if (denominator === 0n || numerator % denominator !== 0n) throw new Error('Derived metric requires an exact six-decimal result and nonzero divisor');
 return numerator / denominator;
};
export interface ObservationInput {
 key: string; metric: string; subject: string; value: string; unit: string;
 observedAt?: string; from?: string; until?: string;
 source: string; sourceRecord: string; support?: string;
}
/** Durable business measurements; telemetry ingestion is a separate authorized producer. */
export class Measurements {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(id: string, ctx: CallContext): Effect.Effect<VerifiedObservation, ForgeError> {
  const self = this, seen = new Set<string>();
  function visit(key: string, depth: number): Effect.Effect<VerifiedObservation, ForgeError> {
   return Effect.gen(function* () {
    if (depth > 8 || seen.size >= 255 || seen.has(key)) return yield* Effect.fail(bad('Derived metric exceeds its depth/budget or reuses an input'));
    seen.add(key);
    const row = yield* self.call('MetricObservation.get', { id: key }, ctx);
    const metric = yield* self.call('MetricDefinition.get', { id: row.metric }, ctx);
    yield* self.call('MetricSubject.get', { id: row.subject }, ctx);
    for (const id of [metric.definition, metric.semantics]) yield* self.engine.call(s + 'SpecificationPin.get', { id }, ctx);
    yield* self.engine.call(e + 'EvidenceSource.get', { id: row.source }, ctx);
    if (row.support) {
     const seal = yield* self.engine.call(e + 'EvidenceSeal.get', { id: row.support }, ctx);
     yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    }
    if (row.operation === 'sample') return { row, metric, leaves: new Set([key]), samples: 1n };
    const left = yield* visit(String(row.left), depth + 1), right = yield* visit(String(row.right), depth + 1);
    const result = yield* self.calculate(row, metric, left, right);
    if (toMinor(String(row.value), 6) !== result.value) return yield* Effect.fail(bad('Derived observation differs from its pinned inputs'));
    return { row, metric, leaves: new Set([...left.leaves, ...right.leaves]), samples: result.samples };
   });
  }
  return visit(id, 1);
 }
 private calculate(row: Wire, metric: Wire, left: VerifiedObservation, right: VerifiedObservation) {
  return Effect.try({ try: () => {
   const a = left.row, b = right.row, op = String(row.operation);
   if (a.subject !== row.subject || b.subject !== row.subject || [...left.leaves].some(id => right.leaves.has(id))) throw new Error('Inputs must have the same subject and disjoint provenance');
   const start = (r: Wire) => Date.parse(decodeDatetime(String(r.observedAt ?? r.from))), end = (r: Wire) => Date.parse(decodeDatetime(String(r.observedAt ?? r.until)));
   if ([a, b].some(r => start(r) < start(row) || end(r) > end(row) || (row.from && r.observedAt && start(r) === end(row)))) throw new Error('Inputs must fit the observation period');
   const x = toMinor(String(a.value), 6), y = toMinor(String(b.value), 6);
   if (op === 'sum' || op === 'mean') {
    if (a.metric !== row.metric || b.metric !== row.metric) throw new Error('Aggregation requires the exact same metric definition');
    if (a.from && b.from && start(a) < end(b) && start(b) < end(a)) throw new Error('Aggregated intervals must not overlap');
    if (op === 'mean' && [a, b].some(r => !['sample', 'mean'].includes(String(r.operation)))) throw new Error('Mean inputs must be samples or means');
    const samples = left.samples + right.samples;
    return { value: op === 'sum' ? x + y : divide(x * left.samples + y * right.samples, samples), samples };
   }
   if (start(a) !== start(row) || start(b) !== start(row) || end(a) !== end(row) || end(b) !== end(row)) throw new Error('Derived indicators require aligned measurement periods');
   if (metric.unit !== 'ratio') throw new Error('Derived product/ratio output must be dimensionless (ratio)');
   if (op === 'product') {
    if (a.unit !== 'ratio' || b.unit !== 'ratio') throw new Error('Product requires dimensionless inputs');
    return { value: divide(x * y, 1_000_000n), samples: 1n };
   }
   if (op === 'ratio') {
    if (a.unit !== b.unit || left.metric.dimension !== right.metric.dimension) throw new Error('Ratio requires compatible input units and dimensions');
    return { value: divide(x * 1_000_000n, y), samples: 1n };
   }
   throw new Error('Unsupported derivation');
  }, catch: error => bad(String(error)) });
 }
 observation(id: string, ctx: CallContext) { return this.read(id, ctx).pipe(Effect.map(result => result.row)); }
 record(input: ObservationInput, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   yield* self.call('MetricDefinition.get', { id: input.metric }, ctx);
   yield* self.call('MetricSubject.get', { id: input.subject }, ctx);
   yield* self.engine.call(e + 'EvidenceSource.get', { id: input.source }, ctx);
   return yield* self.call('MetricObservation.create', { ...input, observedAt: input.observedAt ?? null, from: input.from ?? null, until: input.until ?? null, support: input.support ?? null, operation: 'sample', left: null, right: null, depth: 1 }, ctx);
  });
 }
 derive(input: Omit<ObservationInput, 'value'> & { operation: 'sum' | 'mean' | 'ratio' | 'product'; left: string; right: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const left = yield* self.read(input.left, ctx), right = yield* self.read(input.right, ctx);
   const metric = yield* self.call('MetricDefinition.get', { id: input.metric }, ctx);
   const row = { ...input, observedAt: input.observedAt ?? null, from: input.from ?? null, until: input.until ?? null, support: input.support ?? null, depth: Math.max(Number(left.row.depth), Number(right.row.depth)) + 1 };
   const result = yield* self.calculate(row, metric, left, right);
   return yield* self.call('MetricObservation.create', { ...row, value: formatMinor(result.value, 6) }, ctx);
  });
 }
 assessment(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('PerformanceAssessment.get', { id }, ctx);
   const objective = yield* self.call('MetricObjective.get', { id: row.objective }, ctx);
   yield* self.engine.call(s + 'SpecificationPin.get', { id: objective.policy }, ctx);
   const observation = yield* self.observation(String(row.observation), ctx);
   const start = String(observation.observedAt ?? observation.from), end = String(observation.observedAt ?? observation.until);
   if (start < String(objective.from) || start >= String(objective.until) || end > String(objective.until)) return yield* Effect.fail(bad('Observation falls outside the objective period'));
   if (row.evaluation) yield* new Evaluations(self.engine).result(String(row.evaluation), ctx);
   const actual = toMinor(String(observation.value), 6), target = toMinor(String(objective.target), 6);
   const breached = objective.minimum != null && actual < toMinor(String(objective.minimum), 6) || objective.maximum != null && actual > toMinor(String(objective.maximum), 6);
   return { row, objective, observation, actual: formatMinor(actual, 6), expected: formatMinor(target, 6), variance: formatMinor(actual - target, 6), status: breached ? 'breached' as const : 'met' as const };
  });
 }
 breach(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const event = yield* self.call('MetricBreachEvent.get', { id }, ctx);
   const assessment = yield* self.assessment(String(event.assessment), ctx);
   if (assessment.status !== 'breached' || String(event.occurredAt) < String(assessment.observation.observedAt ?? assessment.observation.until)) return yield* Effect.fail(bad('Breach requires a failed threshold after the observation'));
   return { event, assessment };
  });
 }
 effect(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const effect = yield* self.call('MetricBreachEffect.get', { id }, ctx);
   const breach = yield* self.breach(String(effect.breach), ctx);
   const fulfillment = yield* self.engine.call('@forgegraph/foundation/fulfillment/_/Fulfillment.get', { id: effect.fulfillment }, ctx);
   return { effect, breach, fulfillment };
  });
 }
}
