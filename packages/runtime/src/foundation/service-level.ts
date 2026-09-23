import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Storage } from "../services.js";
import { AgreementCatalog } from "./agreement-catalog.js";
import { Availability } from "./availability.js";
import { findTerminalFact } from "./facts.js";
import { Fulfillments } from "./fulfillment.js";
const p = "@forgegraph/foundation/service-level/_/", MINUTE = 60000;
function check(value: unknown, detail: string) { return value ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
function instant(value: unknown): number { const result = Date.parse(decodeDatetime(String(value))); if (result % MINUTE !== 0) throw new Error("Service-level clocks require whole-minute instants"); return result; }
export interface ServiceState { instance: Wire; objective: Wire; events: Wire[]; elapsedMinutes: number; dueAt: string | null; paused: boolean; finished: Wire | null; breached: boolean; verdict: "Running" | "Paused" | "AtRisk" | "Met" | "Breached" }
export class ServiceLevels {
  constructor(private readonly engine: Engine) {}
  private call(op: string, body: Wire, ctx: CallContext) { return this.engine.call(p + op, body, ctx); }
  private find(resource: string, values: Wire, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () { const model = self.engine.model.resource(p + resource), unique = model.uniques.find(u => !u.condition && u.fields.length === Object.keys(values).length && u.fields.every(f => Object.hasOwn(values, f)))!; const row = yield* (yield* Storage).findUnique(ctx.tenant, model, unique, self.engine.claimKey(model, unique, values)!, values); return row ? yield* self.call(resource + ".get", { id: row.id }, ctx) : null; }).pipe(Effect.provide(self.engine.layer));
  }
  start(input: { key: string; objective: string; agreement: string; right: string; fulfillment: string; startedAt: string; horizon: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* Effect.try({ try: () => { const start = instant(input.startedAt), end = instant(input.horizon); if (end <= start || end - start > 31 * 24 * 60 * MINUTE) throw new Error("Clock horizon must be positive and at most 31 days"); }, catch: e => err("ValidationFailed", String(e)) });
      const rights = yield* new AgreementCatalog(self.engine).rightsAt(input.agreement, input.startedAt, ctx);
      const link = yield* self.engine.call("@forgegraph/foundation/agreement-catalog/_/AgreementEntitlementLink.get", { id: input.right }, ctx);
      yield* check(rights.some(right => right.id === link.entitlement), "Service-level instance requires an effective agreement right at its start");
      yield* check(!(yield* new Fulfillments(self.engine).status(input.fulfillment, ctx)).end, "Cannot start tracking completed fulfillment");
      const entitlementEnd = yield* findTerminalFact(self.engine, "@forgegraph/foundation/entitlement/_/EntitlementEnd", "entitlement", link.entitlement, ctx);
      return yield* self.call("ServiceLevelInstance.create", { ...input, entitlement: link.entitlement, entitlementEnd: entitlementEnd?.id ?? null }, ctx);
    });
  }
  state(instanceId: string, at: string, ctx: CallContext): Effect.Effect<ServiceState, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instance = yield* self.call("ServiceLevelInstance.get", { id: instanceId }, ctx), objective = yield* self.call("ServiceLevelObjective.get", { id: instance.objective }, ctx), policy = yield* self.call("ServiceLevelPolicy.get", { id: objective.policy }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: policy.specification }, ctx);
      const agreement = yield* new AgreementCatalog(self.engine).state(String(instance.agreement), String(instance.startedAt), ctx);
      yield* check(agreement.phase === "Active" && agreement.issuance?.right === instance.right && Date.parse(String(agreement.agreement.validFrom)) <= Date.parse(String(instance.startedAt)) && Date.parse(String(instance.startedAt)) < Date.parse(String(agreement.agreement.validUntil)), "Instance does not pin an issued agreement right within validity");
      yield* self.engine.call("@forgegraph/foundation/agreement-catalog/_/AgreementEntitlementLink.get", { id: instance.right }, ctx);
      yield* self.engine.call("@forgegraph/foundation/entitlement/_/Entitlement.get", { id: instance.entitlement }, ctx);
      if (instance.entitlementEnd != null) yield* self.engine.call("@forgegraph/foundation/entitlement/_/EntitlementEnd.get", { id: instance.entitlementEnd }, ctx);
      const bounds = yield* Effect.try({ try: () => { const start = instant(instance.startedAt), end = instant(instance.horizon), query = instant(at); if (end <= start || end - start > 31 * 24 * 60 * MINUTE || query < start || query > end) throw new Error("Service-level query is outside its pinned 31-day horizon"); return { start, end, query }; }, catch: e => err("ValidationFailed", String(e)) });
      const windows = policy.clock === "Business" ? (yield* new Availability(self.engine).effectiveWindows(String(policy.calendar), String(instance.startedAt), String(instance.horizon), ctx)).windows.map(w => [Date.parse(w.from), Date.parse(w.until)] as const) : [[bounds.start, bounds.end] as const];
      const events: Wire[] = [], pauses: [number, number][] = []; let pausedAt: number | null = null, finished: Wire | null = null, breached = false;
      const elapsed = (until: number) => {
        let minutes = 0;
        for (let current = bounds.start; current < until; current += MINUTE) if (windows.some(([start, end]) => current >= start && current < end) && !pauses.some(([start, end]) => current >= start && current < end) && !(pausedAt != null && current >= pausedAt)) minutes++;
        return minutes;
      };
      for (let ordinal = 0; ordinal < 64; ordinal++) {
        const event = yield* self.find("ServiceLevelEvent", { instance: instanceId, ordinal }, ctx); if (!event) break;
        const when = yield* Effect.try({ try: () => instant(event.at), catch: e => err("ValidationFailed", String(e)) });
        yield* check(!finished && when >= (events.length ? Date.parse(String(events.at(-1)!.at)) : bounds.start), "Invalid service-level history order");
        if (when > bounds.query) break;
        if (event.kind === "Paused") { yield* check(pausedAt == null, "Clock is already paused"); pausedAt = when; }
        else if (event.kind === "Resumed") { yield* check(pausedAt != null, "Clock is not paused"); pauses.push([pausedAt!, when]); pausedAt = null; }
        else {
          const evaluation = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: event.evaluation }, ctx);
          const run = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationRun.get", { id: evaluation.run }, ctx);
          yield* check(evaluation.outcome === "Completed" && run.definition === policy.specification, "Assessment uses the wrong pinned evaluation definition");
          if (event.finished != null) finished = yield* self.engine.call("@forgegraph/foundation/fulfillment/_/FulfillmentEnd.get", { id: event.finished }, ctx);
          const until = finished ? Math.min(when, Date.parse(String(finished.endedAt))) : when, used = elapsed(until);
          const verdict: ServiceState["verdict"] = breached || (finished != null && (finished.outcome !== "completed" || finished.coverage !== "complete")) || used > Number(objective.targetMinutes) ? "Breached" : finished?.outcome === "completed" && finished.coverage === "complete" ? "Met" : pausedAt != null ? "Paused" : used >= Number(objective.warningMinutes) ? "AtRisk" : "Running";
          yield* check(event.elapsedMinutes === used && event.verdict === verdict, "Assessment does not match pinned clock history");
          breached ||= verdict === "Breached";
        }
        events.push(event);
      }
      const elapsedMinutes = elapsed(finished ? Math.min(bounds.query, Date.parse(String(finished.endedAt))) : bounds.query);
      let dueAt: string | null = null;
      if (pausedAt == null) { let count = 0; for (let minute = bounds.start; minute < bounds.end; minute += MINUTE) { if (windows.some(([start, end]) => minute >= start && minute < end) && !pauses.some(([start, end]) => minute >= start && minute < end)) count++; if (count >= Number(objective.targetMinutes)) { dueAt = new Date(minute + MINUTE).toISOString(); break; } } }
      const verdict: ServiceState["verdict"] = breached || (finished != null && (finished.outcome !== "completed" || finished.coverage !== "complete")) || elapsedMinutes > Number(objective.targetMinutes) ? "Breached" : finished?.outcome === "completed" && finished.coverage === "complete" ? "Met" : pausedAt != null ? "Paused" : elapsedMinutes >= Number(objective.warningMinutes) ? "AtRisk" : "Running";
      return { instance, objective, events, elapsedMinutes, dueAt, paused: pausedAt != null, finished, breached, verdict };
    });
  }
  pause(instance: string, at: string, reason: string, ctx: CallContext) { return this.clockEvent(instance, "Paused", at, reason, ctx); }
  resume(instance: string, at: string, reason: string, ctx: CallContext) { return this.clockEvent(instance, "Resumed", at, reason, ctx); }
  private clockEvent(instance: string, kind: "Paused" | "Resumed", at: string, reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this; return Effect.gen(function* () { const state = yield* self.state(instance, at, ctx); yield* check(!state.finished && state.paused !== (kind === "Paused"), "Invalid clock transition"); return yield* self.call("ServiceLevelEvent.create", { instance, ordinal: state.events.length, previous: state.events.at(-1)?.id ?? null, kind, at, elapsedMinutes: state.elapsedMinutes, verdict: kind === "Paused" ? "Paused" : state.verdict, evaluation: null, finished: null, reason, recordedBy: ctx.actor }, ctx); });
  }
  assess(instance: string, at: string, evaluation: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.state(instance, at, ctx); yield* check(!state.finished, "Service-level tracking is terminal");
      const policy = yield* self.call("ServiceLevelPolicy.get", { id: state.objective.policy }, ctx), finish = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: evaluation }, ctx), run = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationRun.get", { id: finish.run }, ctx);
      yield* check(finish.outcome === "Completed" && run.definition === policy.specification, "Assessment uses the wrong pinned evaluation definition");
      const fulfillment = yield* new Fulfillments(self.engine).status(String(state.instance.fulfillment), ctx);
      const end = fulfillment.end && Date.parse(String(fulfillment.end.endedAt)) <= Date.parse(at) ? fulfillment.end : null;
      const completion = end ? yield* self.state(instance, String(end.endedAt), ctx) : state;
      const used = completion.elapsedMinutes, verdict: ServiceState["verdict"] = state.breached || (end != null && (end.outcome !== "completed" || end.coverage !== "complete")) || used > Number(state.objective.targetMinutes) ? "Breached" : end?.outcome === "completed" && end.coverage === "complete" ? "Met" : state.paused ? "Paused" : used >= Number(state.objective.warningMinutes) ? "AtRisk" : "Running";
      return yield* self.call("ServiceLevelEvent.create", { instance, ordinal: state.events.length, previous: state.events.at(-1)?.id ?? null, kind: "Assessed", at, elapsedMinutes: used, verdict, evaluation, finished: end?.id ?? null, reason: "Pinned clock assessment", recordedBy: ctx.actor }, ctx);
    });
  }
  breach(instance: string, at: string, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this; return Effect.gen(function* () { const state = yield* self.state(instance, at, ctx), first = state.events.find(e => e.kind === "Assessed" && e.verdict === "Breached"); if (!first) return null; return yield* self.call("ServiceLevelBreach.create", { instance, assessment: first.id }, { ...ctx, idempotencyKey: `service-breach:${instance}` }); });
  }
  remedy(breach: string, input: { obligation?: string; fulfillment?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this; return Effect.gen(function* () { const fact = yield* self.call("ServiceLevelBreach.get", { id: breach }, ctx), assessment = yield* self.call("ServiceLevelEvent.get", { id: fact.assessment }, ctx); const state = yield* self.state(String(fact.instance), String(assessment.at), ctx); yield* check(state.breached, "Breach is not an authoritative assessment"); return yield* self.call("ServiceLevelRemedy.create", { breach, obligation: input.obligation ?? null, fulfillment: input.fulfillment ?? null }, { ...ctx, idempotencyKey: `service-remedy:${breach}` }); });
  }
}
