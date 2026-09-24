import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { err, type ForgeError } from '../errors.js';
import { Assets } from './asset-lifecycle.js';
import { Demands } from './demand.js';
import { Fulfillments } from './fulfillment.js';
import { Qualifications } from './qualification.js';
import { Routing } from './routing.js';
import { Scheduling } from './scheduling.js';
import { Operations } from './operations.js';
import { Inventory } from './inventory.js';
import { Measurements } from './measurement.js';
import { Evaluations } from './evaluation.js';
import { Decisions } from './decision.js';
import { Evidence } from './evidence.js';
import { Usage } from './usage.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/maintenance/_/';
const fail = (detail: string) => Effect.fail(err('ValidationFailed', detail));
export class Maintenance {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const seal = yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get', { id }, ctx);
   yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
  });
 }
 inspect(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('MaintenanceWorkOrder.get', { id }, ctx);
   const asset = yield* new Assets(self.engine).state(String(row.asset), ctx), demand = yield* new Demands(self.engine).state(String(row.demand), ctx);
   if (demand.resolution?.id !== row.conversion || demand.resolution?.fulfillment !== row.fulfillment) return yield* fail('Work requires the admitted demand conversion');
   const fulfillment = yield* self.engine.call('@forgegraph/foundation/fulfillment/_/Fulfillment.get', { id: row.fulfillment }, ctx);
   if (fulfillment.specificationPin !== demand.row.specification) return yield* fail('Maintenance execution specification differs from demand');
   const execution = yield* new Fulfillments(self.engine).status(String(row.fulfillment), ctx);
   const qualification = yield* new Qualifications(self.engine).satisfies(String(row.technician), String(row.requirement), String(demand.row.from), ctx);
   const endQualification = yield* new Qualifications(self.engine).satisfies(String(row.technician), String(row.requirement), new Date(Date.parse(String(demand.row.until)) - 1).toISOString(), ctx);
   if (!qualification.qualified || endQualification.qualification !== qualification.qualification) return yield* fail('Technician does not meet the pinned work requirement');
   if (row.plan) {
    const plan = yield* self.call('MaintenancePlan.get', { id: row.plan }, ctx);
    const due = Date.parse(String(plan.anchor)) + (Number(row.cycle) - 1) * Number(plan.intervalDays) * 86_400_000;
    if (row.trigger === 'preventive' && Date.parse(String(demand.row.from)) !== due) return yield* fail('Preventive work does not match its recurring UTC plan cycle');
   }
   if (row.condition && (yield* new Measurements(self.engine).assessment(String(row.condition), ctx)).status !== 'breached') return yield* fail('Condition work requires a breached performance assessment');
   if (row.defect) yield* self.support(row.defect, ctx);
   if (row.assignment) {
    const routing = yield* new Routing(self.engine).inspect(String(row.assignment), ctx);
    if (routing.facts.resource.subject !== row.technician || routing.facts.request.requirement !== row.requirement || routing.facts.request.fulfillment !== fulfillment.fulfillmentSet || routing.facts.resource.executor !== fulfillment.executor) return yield* fail('Routing assignment does not match the maintenance work');
   }
   if (row.appointment) {
    const appointment = yield* new Scheduling(self.engine).inspect(String(row.appointment), ctx);
    if (!appointment.commit || appointment.appointment.fulfillment !== fulfillment.fulfillmentSet) return yield* fail('Maintenance appointment is not published for this work');
   }
   let usage = null, operation = null;
   if (row.operation) {
    const link = yield* self.engine.call('@forgegraph/foundation/operations/_/OperationFulfillmentLink.get', { id: row.operation }, ctx);
    const run = yield* self.engine.call('@forgegraph/foundation/operations/_/OperationRun.get', { id: link.run }, ctx);
    const definition = yield* self.engine.call('@forgegraph/foundation/operations/_/Operation.get', { id: run.operation }, ctx);
    if (definition.definition !== fulfillment.specificationPin) return yield* fail('Maintenance operation differs from execution specification');
    operation = yield* new Operations(self.engine).state(String(run.id), ctx);
    usage = yield* new Usage(self.engine).aggregate(String(run.usageStream), String(demand.row.from), String(demand.row.until), ctx);
   }
   const parts: Wire[] = []; let cursor: string | undefined;
   do {
    const page = yield* self.call('MaintenancePart.list.byOrder', { params: { order: id }, limit: 16, ...(cursor ? { cursor } : {}) }, ctx);
    parts.push(...page.items as Wire[]);
    if (parts.length > 16) return yield* fail('Maintenance parts exceed the bounded set');
    cursor = page.next == null ? undefined : String(page.next);
   } while (cursor);
   parts.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
   if (parts.length !== row.partCount || parts.some((r, i) => Number(r.ordinal) !== i + 1)) return yield* fail('Maintenance parts are incomplete or unreadable');
   for (const part of parts) {
    const movement = yield* self.engine.call('@forgegraph/foundation/inventory/_/InventoryMovement.get', { id: part.movement }, ctx);
    const position = yield* new Inventory(self.engine).position(String(movement.position), ctx);
    if (!position.events.some(e => e.id === movement.id) || String(movement.at) < String(demand.row.from) || String(movement.at) > String(demand.row.until)) return yield* fail('Maintenance part is not admitted in the work interval');
   }
   yield* self.engine.call('@forgegraph/foundation/evaluation/_/EvaluationRun.get', { id: row.inspection }, ctx);
   const approval = yield* new Decisions(self.engine).state(String(row.approval), ctx);
   const finish = yield* findTerminalFact(self.engine, p + 'MaintenanceFinish', 'order', id, ctx);
   if (finish) {
    const inspection = yield* new Evaluations(self.engine).result(String(finish.inspection), ctx);
    yield* self.support(finish.evidence, ctx);
    if (execution.phase !== 'completed' || execution.coverage !== 'complete' || String(execution.end!.endedAt) > String(inspection.finishedAt) || approval.outcome?.selected !== row.accepted) return yield* fail('Maintenance completion requires complete execution and accepted inspection criteria');
    if (finish.returnToService) {
     const returned = asset.events.find(e => e.id === finish.returnToService);
     if (!returned || returned.action !== 'commission' || String(returned.at) < String(inspection.finishedAt) || String(approval.terminal?.createdAt) > String(returned.at)) return yield* fail('Return to service must follow inspection and accepted decision');
    }
    if (finish.followUp) yield* new Demands(self.engine).state(String(finish.followUp), ctx);
   }
   return { row, asset, demand, execution, qualification, operation, usage, parts, approval, finish };
  });
 }
 finish(input: { order: string; inspection: string; evidence: string; returnToService?: string; followUp?: string; at: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const state = yield* self.inspect(input.order, ctx), inspection = yield* new Evaluations(self.engine).result(input.inspection, ctx);
   if (state.finish || state.execution.phase !== 'completed' || state.execution.coverage !== 'complete' || String(state.execution.end!.endedAt) > String(inspection.finishedAt) || state.approval.outcome?.selected !== state.row.accepted) return yield* fail('Maintenance must complete execution and acceptance before finishing');
   yield* self.support(input.evidence, ctx);
   if (input.returnToService) {
    const returned = state.asset.events.find(e => e.id === input.returnToService);
    if (!returned || returned.action !== 'commission' || String(returned.at) < String(inspection.finishedAt) || String(state.approval.terminal?.createdAt) > String(returned.at)) return yield* fail('Return to service requires inspected and accepted lifecycle evidence');
   }
   if (input.followUp) yield* new Demands(self.engine).state(input.followUp, ctx);
   return yield* self.call('MaintenanceFinish.create', { ...input, returnToService: input.returnToService ?? null, followUp: input.followUp ?? null }, ctx);
  });
 }
 history(asset: string, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   yield* new Assets(self.engine).state(asset, ctx);
   const rows: Wire[] = []; let cursor: string | undefined;
   do {
    const page = yield* self.call('MaintenanceWorkOrder.list.byAsset', { params: { asset }, limit: 32, ...(cursor ? { cursor } : {}) }, ctx);
    rows.push(...page.items as Wire[]);
    if (rows.length > 128) return yield* fail('Maintenance history exceeds 128 work orders');
    cursor = page.next == null ? undefined : String(page.next);
   } while (cursor);
   return rows;
  });
 }
}
