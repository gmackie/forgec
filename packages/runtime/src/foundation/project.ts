import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, formatMinor, toMinor } from '../codecs.js';
import { err, type ForgeError } from '../errors.js';
import { Fulfillments } from './fulfillment.js';
import { Usage } from './usage.js';
import { Budgets } from './planning-budget.js';
import { Scheduling } from './scheduling.js';
import { Allocations } from './allocation.js';
import { Evaluations } from './evaluation.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/project/_/', plan = '@forgegraph/foundation/planning-budget/_/', f = '@forgegraph/foundation/fulfillment/_/';
interface WorkProgress { row: Wire; phase: string; complete: boolean; start: string | null; end: string | null; actual: string | null; variance: string | null; usageEvents: string[]; allocation: unknown; appointment: unknown }
export class Projects {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private members(type: string, project: string, count: number, bound: number, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const rows: Wire[] = []; let cursor: string | undefined;
   do {
    const page = yield* self.call(type + '.list.byProject', { params: { project }, limit: bound, ...(cursor ? { cursor } : {}) }, ctx);
    rows.push(...page.items as Wire[]);
    if (rows.length > bound) return yield* Effect.fail(err('BudgetExceeded', 'Project graph exceeds its bound'));
    cursor = page.next == null ? undefined : String(page.next);
   } while (cursor);
   rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
   if (rows.length !== count || rows.some((r, i) => Number(r.ordinal) !== i + 1)) return yield* Effect.fail(err('ValidationFailed', 'Project graph is incomplete or unreadable'));
   return rows;
  });
 }
 progress(project: string, through: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const at = yield* Effect.try({ try: () => decodeDatetime(through), catch: () => err('ValidationFailed', 'Invalid progress cutoff') });
   const row = yield* self.call('Project.get', { id: project }, ctx);
   for (const id of [row.sponsor, row.owner]) yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id }, ctx);
   yield* self.engine.call('@forgegraph/foundation/participation/_/ParticipationSet.get', { id: row.participants }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.scope }, ctx);
   const projectPlan = yield* self.engine.call(plan + 'Plan.get', { id: row.plan }, ctx), goal = yield* self.engine.call(plan + 'Goal.get', { id: row.goal }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: projectPlan.definition }, ctx);
   const program = row.program ? yield* self.call('Program.get', { id: row.program }, ctx) : null;
   if (program) {
    yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id: program.sponsor }, ctx);
    yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: program.scope }, ctx);
   }
   const forecast = row.forecast ? yield* self.engine.call(plan + 'ForecastScenario.get', { id: row.forecast }, ctx) : null;
   if (forecast) yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: forecast.assumptions }, ctx);
   const budget = row.budget ? yield* new Budgets(self.engine).state(String(row.budget), ctx) : null;
   const packages = yield* self.members('WorkPackage', project, Number(row.workCount), 16, ctx), dependencies = yield* self.members('ProjectDependency', project, Number(row.dependencyCount), 32, ctx);
   const ids = new Set(packages.map(w => String(w.id))), descendants = new Set(packages.filter(w => w.parent).map(w => String(w.parent)));
   if (packages.some(w => w.parent && !ids.has(String(w.parent)))) return yield* Effect.fail(err('ValidationFailed', 'WBS parent is outside the complete work set'));
   const edges = new Map<string, string[]>();
   for (const edge of dependencies) {
    if (!ids.has(String(edge.predecessor)) || !ids.has(String(edge.successor))) return yield* Effect.fail(err('ValidationFailed', 'Dependency endpoint is outside the work set'));
    edges.set(String(edge.predecessor), [...edges.get(String(edge.predecessor)) ?? [], String(edge.successor)]);
   }
   const visiting = new Set<string>(), done = new Set<string>();
   function acyclic(id: string): boolean {
    if (visiting.has(id)) return false;
    if (done.has(id)) return true;
    visiting.add(id);
    if ((edges.get(id) ?? []).some(child => !acyclic(child))) return false;
    visiting.delete(id); done.add(id); return true;
   }
   if (packages.some(w => !acyclic(String(w.id)))) return yield* Effect.fail(err('ValidationFailed', 'Dependency graph has a cycle'));
   const work: WorkProgress[] = [];
   for (const item of packages) {
    yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: item.scope }, ctx);
    const execution = yield* self.engine.call(f + 'Fulfillment.get', { id: item.fulfillment }, ctx), status = yield* new Fulfillments(self.engine).status(String(item.fulfillment), ctx);
    const start = yield* findTerminalFact(self.engine, f + 'FulfillmentStart', 'fulfillment', item.fulfillment, ctx);
    const began = start && String(start.beganAt) <= at ? String(start.beganAt) : null;
    const ended = status.end && String(status.end.endedAt) <= at ? String(status.end.endedAt) : null;
    const phase = ended ? status.phase : began ? 'running' : 'pending';
    const usage = item.usage && at > String(item.from) ? yield* new Usage(self.engine).aggregate(String(item.usage), String(item.from), at, ctx) : null;
    if (item.usage) {
     const stream = yield* self.engine.call('@forgegraph/foundation/usage/_/UsageStream.get', { id: item.usage }, ctx);
     const dimension = yield* self.engine.call('@forgegraph/foundation/usage/_/UsageDimension.get', { id: stream.dimension }, ctx);
     if (dimension.unit !== item.unit) return yield* Effect.fail(err('ValidationFailed', 'Actual usage unit differs from planned work'));
    }
    const allocation = item.allocation ? yield* new Allocations(self.engine).reservation(String(item.allocation), ctx) : null;
    const appointment = item.appointment ? yield* new Scheduling(self.engine).inspect(String(item.appointment), ctx) : null;
    if (appointment && appointment.appointment.fulfillment !== execution.fulfillmentSet) return yield* Effect.fail(err('ValidationFailed', 'Appointment belongs to another fulfillment set'));
    if (item.milestone) {
     const milestone = yield* self.engine.call(plan + 'Milestone.get', { id: item.milestone }, ctx);
     if (milestone.fulfillmentSet !== execution.fulfillmentSet) return yield* Effect.fail(err('ValidationFailed', 'Milestone belongs to another fulfillment set'));
    }
    const actual = item.usage ? usage?.quantity ?? '0.000000' : null;
    work.push({ row: item, phase, complete: phase === 'completed' && status.coverage === 'complete', start: began, end: ended, actual, variance: actual == null ? null : formatMinor(toMinor(actual, 6) - toMinor(String(item.planned), 6), 6), usageEvents: usage?.eventIds ?? [], allocation, appointment });
   }
   const constraints = dependencies.map(edge => {
    const before = work.find(w => w.row.id === edge.predecessor)!, after = work.find(w => w.row.id === edge.successor)!;
    const source = edge.kind === 'startToStart' ? before.start : before.end;
    const target = edge.kind === 'finishToFinish' ? after.end : after.start;
    const planSource = edge.kind === 'startToStart' ? before.row.from : before.row.until, planTarget = edge.kind === 'finishToFinish' ? after.row.until : after.row.from;
    return { edge, planSatisfied: String(planSource) <= String(planTarget), ready: source != null && (edge.kind === 'startToStart' || before.complete), violated: target != null && (source == null || source > target || edge.kind !== 'startToStart' && !before.complete) };
   });
   const leaves = work.filter(w => !descendants.has(String(w.row.id)));
   return { row, program, goal, forecast, budget, work, dependencies: constraints, plannedLeafCount: leaves.length, completedLeafCount: leaves.filter(w => w.complete).length, plannedDueLeafCount: leaves.filter(w => String(w.row.until) <= at).length, overdue: leaves.filter(w => !w.complete && String(w.row.until) < at).map(w => String(w.row.id)), through: at };
  });
 }
 milestone(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('ProjectMilestoneResult.get', { id }, ctx), work = yield* self.call('WorkPackage.get', { id: row.work }, ctx);
   const milestone = yield* self.engine.call(plan + 'Milestone.get', { id: row.milestone }, ctx), evaluation = yield* new Evaluations(self.engine).result(String(row.evaluation), ctx);
   return { row, work, milestone, evaluation };
  });
 }
}
