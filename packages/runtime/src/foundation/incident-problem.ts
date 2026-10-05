import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err } from '../errors.js';
import { Cases } from './case-management.js';
import { Evidence } from './evidence.js';
import { Evaluations } from './evaluation.js';
import { Decisions } from './decision.js';
import { Fulfillments } from './fulfillment.js';
import { Changes } from './change.js';
import { ServiceLevels } from './service-level.js';
const p = '@forgegraph/foundation/incident-problem/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
export class Incidents {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const seal = yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get', { id }, ctx);
   yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
  });
 }
 incident(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('Incident.get', { id }, ctx), activity = yield* new Cases(self.engine).state(String(row.case), ctx);
   yield* self.support(row.source, ctx);
   if (row.risk) yield* self.engine.call('@forgegraph/foundation/risk/_/Risk.get', { id: row.risk }, ctx);
   if (row.finding) {
    const finding = yield* self.engine.call('@forgegraph/foundation/assurance/_/Finding.get', { id: row.finding }, ctx);
    yield* new Evaluations(self.engine).result(String(finding.finish), ctx);
   }
   const serviceLevel = row.serviceLevel ? yield* new ServiceLevels(self.engine).state(String(row.serviceLevel), at, ctx) : null;
   return { row, activity, serviceLevel };
  });
 }
 problem(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('Problem.get', { id }, ctx), activity = yield* new Cases(self.engine).state(String(row.case), ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.hypothesis }, ctx);
   yield* self.engine.call('@forgegraph/foundation/evaluation/_/EvaluationRun.get', { id: row.diagnosis }, ctx);
   yield* self.support(row.support, ctx);
   return { row, activity };
  });
 }
 correlation(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('IncidentCorrelation.get', { id }, ctx), incident = yield* self.incident(String(row.incident), at, ctx), problem = yield* self.problem(String(row.problem), ctx);
   yield* self.support(row.support, ctx);
   return { row, incident, problem };
  });
 }
 known(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('KnownProblem.get', { id }, ctx), problem = yield* self.problem(String(row.problem), ctx), diagnosis = yield* new Evaluations(self.engine).result(String(row.diagnosis), ctx), approval = yield* new Decisions(self.engine).state(String(problem.row.approval), ctx);
   if (approval.outcome?.selected !== problem.row.accepted || String(approval.terminal?.createdAt) > String(row.at)) return yield* fail('Known problem requires an accepted diagnosis');
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.workaround }, ctx);
   yield* self.support(row.support, ctx);
   return { row, problem, diagnosis };
  });
 }
 verification(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('ProblemVerification.get', { id }, ctx), remediation = yield* self.call('ProblemRemediation.get', { id: row.remediation }, ctx), problem = yield* self.problem(String(remediation.problem), ctx);
   const fulfillment = yield* new Fulfillments(self.engine).status(String(remediation.fulfillment), ctx), evaluation = yield* new Evaluations(self.engine).result(String(row.evaluation), ctx), approval = yield* new Decisions(self.engine).state(String(remediation.approval), ctx);
   if (fulfillment.phase !== 'completed' || fulfillment.coverage !== 'complete' || String(fulfillment.end!.endedAt) > String(evaluation.finishedAt) || approval.outcome?.selected !== remediation.accepted || String(approval.terminal?.createdAt) > String(row.at)) return yield* fail('Remediation requires complete work and accepted verification');
   if (remediation.change) {
    const change = yield* new Changes(self.engine).state(String(remediation.change), ctx);
    if (change.phase !== 'Completed' || change.implementation?.fulfillment !== remediation.fulfillment) return yield* fail('Change is not completed by this remediation fulfillment');
   }
   yield* self.support(row.support, ctx);
   return { row, remediation, problem, evaluation };
  });
 }
 resolution(id: string, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('IncidentResolution.get', { id }, ctx), correlation = yield* self.correlation(String(row.correlation), at, ctx), verification = yield* self.verification(String(row.verification), ctx);
   if (!correlation.incident.activity.events.some(e => e.id === row.closure)) return yield* fail('Resolution closure is not admitted in case history');
   return { row, correlation, verification, current: correlation.incident.activity.closed && correlation.incident.activity.head === row.closure };
  });
 }
}
