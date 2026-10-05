import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { Storage } from "../services.js";
import { err, type ForgeError } from "../errors.js";
import { Evaluations } from "./evaluation.js";
import { Evidence } from "./evidence.js";
import { AgreementCatalog } from "./agreement-catalog.js";
import { Quotations } from "./quotation-pricing.js";

const p = "@forgegraph/foundation/opportunity/_/";
const e = "@forgegraph/foundation/evaluation/_/";
function check(ok: unknown, detail: string) {
  return ok ? Effect.void : Effect.fail(err("ValidationFailed", detail));
}
export interface PursuitTransition {
  stage: string;
  transition?: string;
  assessment?: string;
  agreement?: string;
  effectiveAt: string;
  nextAction?: string;
  reason: string;
}
/** Pursuit is a possible outcome. Only an issued Agreement proves conversion. */
export class Opportunities {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) {
    return this.engine.call(p + op, input, ctx);
  }
  private event(opportunity: string, ordinal: number, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const resource = self.engine.model.resource(p + "OpportunityEvent");
      const unique = resource.uniques.find(u => u.fields.length === 2 && u.fields.includes("opportunity") && u.fields.includes("ordinal"))!;
      const values = { opportunity, ordinal };
      const row = yield* (yield* Storage).findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
      return row ? yield* self.call("OpportunityEvent.get", { id: row.id }, ctx) : null;
    }).pipe(Effect.provide(self.engine.layer));
  }
  private assessment(id: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.call("OpportunityAssessment.get", { id }, ctx);
      const finish = yield* new Evaluations(self.engine).result(String(row.finish), ctx);
      if (finish.support != null) {
        const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id: finish.support }, ctx);
        yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
      }
      return row;
    });
  }
  state(opportunity: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const row = yield* self.call("Opportunity.get", { id: opportunity }, ctx);
      const definition = yield* self.call("PursuitDefinition.get", { id: row.definition }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: definition.specification }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: row.qualification }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: row.subject }, ctx);
      yield* self.engine.call("@forgegraph/foundation/participation/_/ParticipationSet.get", { id: row.participants }, ctx);
      const events: Wire[] = [];
      for (let ordinal = 0; ordinal < 128; ordinal++) {
        const event = yield* self.event(opportunity, ordinal, ctx);
        if (!event) break;
        const previous = events.at(-1);
        yield* check((event.previous ?? null) === (previous?.id ?? null) && (!previous || previous.outcome === "Open"), "Invalid pursuit history");
        yield* self.call("PursuitStage.get", { id: event.stage }, ctx);
        if (event.transition != null) yield* self.call("StageTransition.get", { id: event.transition }, ctx);
        if (event.assessment != null) yield* self.assessment(String(event.assessment), ctx);
        if (event.agreement != null) {
          const agreement = yield* new AgreementCatalog(self.engine).state(String(event.agreement), String(event.effectiveAt), ctx);
          yield* check(agreement.issuance?.id === event.issuance, "Pursuit lacks issued agreement proof");
        }
        events.push(event);
      }
      return { opportunity: row, events, outcome: events.at(-1)?.outcome ?? "Open", stage: events.at(-1)?.stage ?? null };
    });
  }
  transition(opportunity: string, input: PursuitTransition, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.state(opportunity, ctx);
      yield* check(state.outcome === "Open" && state.events.length < 128, "Pursuit is terminal or journal is full");
      const stage = yield* self.call("PursuitStage.get", { id: input.stage }, ctx);
      if (input.transition) yield* self.call("StageTransition.get", { id: input.transition }, ctx);
      if (input.assessment) yield* self.assessment(input.assessment, ctx);
      const agreement = input.agreement ? yield* new AgreementCatalog(self.engine).state(input.agreement, input.effectiveAt, ctx) : null;
      if (stage.outcome === "Won") yield* check(agreement?.issuance && (agreement.phase === "Active" || agreement.phase === "Scheduled"), "Winning requires an issued active or scheduled agreement");
      return yield* self.call("OpportunityEvent.create", {
        opportunity, ordinal: state.events.length, previous: state.events.at(-1)?.id ?? null,
        stage: input.stage, outcome: stage.outcome, transition: input.transition ?? null,
        assessment: input.assessment ?? null, agreement: input.agreement ?? null,
        issuance: agreement?.issuance?.id ?? null, effectiveAt: input.effectiveAt,
        nextAction: input.nextAction ?? null, reason: input.reason, recordedBy: ctx.actor,
      }, ctx);
    });
  }
  assess(opportunity: string, input: { finish: string; confidence?: string; potentialValue?: string; unit?: string; rationale: string }, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("Opportunity.get", { id: opportunity }, ctx);
      const finish = yield* new Evaluations(self.engine).result(input.finish, ctx);
      yield* self.engine.call(e + "EvaluationRun.get", { id: finish.run }, ctx);
      if (finish.support != null) {
        const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id: finish.support }, ctx);
        yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
      }
      return yield* self.call("OpportunityAssessment.create", { opportunity, run: finish.run, finish: input.finish, confidence: input.confidence ?? null, potentialValue: input.potentialValue ?? null, unit: input.unit ?? null, rationale: input.rationale }, ctx);
    });
  }
  linkQuote(opportunity: string, quote: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("Opportunity.get", { id: opportunity }, ctx);
      yield* new Quotations(self.engine).inspect(quote, ctx);
      return yield* self.call("OpportunityQuote.create", { opportunity, quote }, ctx);
    });
  }
  linkSelection(opportunity: string, solicitation: string, ctx: CallContext) {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("Opportunity.get", { id: opportunity }, ctx);
      yield* self.engine.call("@forgegraph/foundation/selection/_/Solicitation.get", { id: solicitation }, ctx);
      return yield* self.call("OpportunitySelection.create", { opportunity, solicitation }, ctx);
    });
  }
}
