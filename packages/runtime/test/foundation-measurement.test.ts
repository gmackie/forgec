import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { Measurements } from '../src/foundation/measurement.js';
const p = '@forgegraph/foundation/measurement/_/', s = '@forgegraph/foundation/specification/_/', f = '@forgegraph/foundation/fulfillment/_/';
const from = '2026-01-02T00:00:00Z', until = '2026-01-03T00:00:00Z';
for (const adapter of foundationAdapters) it(`${adapter}: durable metric provenance, OEE-like composition and performance breaches`, async () => {
 const h = await foundation('measurement', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, service = new Measurements(engine);
  const repository = await call(s + 'Repository.create', { key: 'metrics', provider: 'git', locator: 'https://example.test/metrics' });
  const pin = await call(s + 'SpecificationPin.create', { repository: repository.id, anchor: 'metrics', revision: 'c'.repeat(40) });
  const subject = await call(p + 'MetricSubject.create', { key: 'production' });
  const source = await call('@forgegraph/foundation/evidence/_/EvidenceSource.create', { key: 'business-observations', label: 'Authorized observation producer' });
  const metric = async (key: string, dimension: string, unit: string) => call(p + 'MetricDefinition.create', { key, definition: pin.id, dimension, unit, semantics: pin.id });
  const availability = await metric('availability', 'proportion', 'ratio'), performance = await metric('performance', 'proportion', 'ratio'), quality = await metric('quality', 'proportion', 'ratio'), intermediate = await metric('combined', 'proportion', 'ratio'), effectiveness = await metric('effectiveness', 'proportion', 'ratio');
  const common = { subject: String(subject.id), from, until, source: String(source.id), unit: 'ratio' };
  const sample = async (key: string, definition: Record<string, unknown>, value: string) => run(service.record({ ...common, key, metric: String(definition.id), value, sourceRecord: key }, ctx));
  const av = await sample('availability', availability, '0.9'), perf = await sample('performance', performance, '0.8'), qual = await sample('quality', quality, '0.95');
  const ap = await run(service.derive({ ...common, key: 'ap', sourceRecord: 'ap', metric: String(intermediate.id), operation: 'product', left: String(av.id), right: String(perf.id) }, ctx));
  const oee = await run(service.derive({ ...common, key: 'oee', sourceRecord: 'oee', metric: String(effectiveness.id), operation: 'product', left: String(ap.id), right: String(qual.id) }, ctx));
  expect((await run(service.observation(String(oee.id), ctx))).value).toBe('0.684000');
  await call('@fixture/measurement-consumer/_/ManufacturingPerformance.create', { observation: oee.id, indicator: 'equipment effectiveness' });
  const objective = await call(p + 'MetricObjective.create', { key: 'effective', metric: effectiveness.id, subject: subject.id, policy: pin.id, target: '0.8', minimum: '0.75', maximum: '1', from, until });
  const assessment = await call(p + 'PerformanceAssessment.create', { objective: objective.id, observation: oee.id, evaluation: null });
  const result = await run(service.assessment(String(assessment.id), ctx));
  expect(result.status).toBe('breached'); expect(result.variance).toBe('-0.116000');
  const event = await call(p + 'MetricBreachEvent.create', { assessment: assessment.id, occurredAt: until });
  expect((await run(service.breach(String(event.id), ctx))).assessment.actual).toBe('0.684000');
  const executor = await call(f + 'FulfillmentExecutor.create', { key: 'remediation' }), set = await call(f + 'FulfillmentSet.create', { label: 'Remediation' });
  const fulfillment = await call(f + 'Fulfillment.create', { fulfillmentSet: set.id, ordinal: 1, specificationPin: pin.id, executor: executor.id, requestedAt: until, evidence: null });
  const effect = await call(p + 'MetricBreachEffect.create', { breach: event.id, fulfillment: fulfillment.id });
  expect((await run(service.effect(String(effect.id), ctx))).fulfillment.id).toBe(fulfillment.id);
  for (const [name, key, field, unit] of [['ServicePerformance', 'latency', 'service', 'ms'], ['ClinicalPerformance', 'wait', 'service', 'minute'], ['AgentPerformance', 'success', 'agent', 'ratio']]) {
   const definition = await metric(key!, key!, unit!);
   const observation = await run(service.record({ key: key!, metric: String(definition.id), subject: String(subject.id), observedAt: from, unit: unit!, value: '10', source: String(source.id), sourceRecord: key! }, ctx));
   await call('@fixture/measurement-consumer/_/' + name + '.create', { observation: observation.id, [field!]: key });
   expect((await run(service.observation(String(observation.id), ctx))).observedAt).toBe('2026-01-02T00:00:00.000Z');
  }
  const point = async (key: string, value: string, observedAt: string) => run(service.record({ key, metric: String(availability.id), subject: String(subject.id), source: String(source.id), sourceRecord: key, unit: 'ratio', value, observedAt }, ctx));
  const x = await point('x', '2', from), y = await point('y', '4', '2026-01-02T01:00:00Z'), z = await point('z', '6', '2026-01-02T02:00:00Z');
  const xy = await run(service.derive({ ...common, key: 'mean2', sourceRecord: 'mean2', metric: String(availability.id), operation: 'mean', left: String(x.id), right: String(y.id) }, ctx));
  const xyz = await run(service.derive({ ...common, key: 'mean3', sourceRecord: 'mean3', metric: String(availability.id), operation: 'mean', left: String(xy.id), right: String(z.id) }, ctx));
  expect((await run(service.observation(String(xyz.id), ctx))).value).toBe('4.000000');
  const sum = await run(service.derive({ ...common, key: 'sum', sourceRecord: 'sum', metric: String(availability.id), operation: 'sum', left: String(x.id), right: String(y.id) }, ctx));
  expect((await run(service.observation(String(sum.id), ctx))).value).toBe('6.000000');
  await expect(run(service.derive({ ...common, key: 'overlap', sourceRecord: 'overlap', metric: String(availability.id), operation: 'sum', left: String(av.id), right: String(xy.id) }, ctx))).rejects.toThrow();
  // CRUD-authored derived candidates never become authority without validation.
  const forged = await call(p + 'MetricObservation.create', { ...common, key: 'forged', sourceRecord: 'forged', metric: effectiveness.id, observedAt: null, support: null, value: '0.9', operation: 'product', left: ap.id, right: qual.id, depth: 3 });
  await expect(run(service.observation(String(forged.id), ctx))).rejects.toThrow();
  await expect(run(service.derive({ ...common, key: 'duplicate', sourceRecord: 'duplicate', metric: String(effectiveness.id), operation: 'product', left: String(av.id), right: String(av.id) }, ctx))).rejects.toThrow();
  const three = await sample('three', availability, '3'), one = await sample('one', availability, '1');
  await expect(run(service.derive({ ...common, key: 'rounded', sourceRecord: 'rounded', metric: String(effectiveness.id), operation: 'ratio', left: String(one.id), right: String(three.id) }, ctx))).rejects.toThrow();
  await expect(run(service.record({ ...common, key: 'wrong-unit', sourceRecord: 'wrong-unit', metric: String(availability.id), value: '1', unit: 'ms' }, ctx))).rejects.toThrow();
  await expect(run(service.observation(String(oee.id), { ...ctx, tenant: 'other' }))).rejects.toThrow();
  await expect(call(p + 'MetricObservation.delete', { id: av.id })).rejects.toThrow();
  const metObjective = await call(p + 'MetricObjective.create', { key: 'met', metric: effectiveness.id, subject: subject.id, policy: pin.id, target: '0.6', minimum: '0.5', maximum: null, from, until });
  const met = await call(p + 'PerformanceAssessment.create', { objective: metObjective.id, observation: oee.id, evaluation: null });
  const fakeBreach = await call(p + 'MetricBreachEvent.create', { assessment: met.id, occurredAt: until });
  await expect(run(service.breach(String(fakeBreach.id), ctx))).rejects.toThrow();
 } finally { await h.close(); }
});
