import { Effect } from "effect";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Storage } from "../services.js";
import { Decisions } from "./decision.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";
export type QualificationPolicy = "None" | "EvaluationCompleted" | "DecisionApproved" | "Both";
export interface RegisterCandidate { series: string; version: string; specification: string; artifact: string; policy: QualificationPolicy; evaluationDefinition?: string; decisionCase?: string; approvedOption?: string; support?: string }
export type PublicationStatus = "Published" | "Deprecated" | "Retired";
export interface PublicationState { events: Wire[]; releases: Map<string, { release: Wire; status: PublicationStatus }>; channels: Map<string, string> }
const p = "@forgegraph/foundation/publication/_/";
function check(value: unknown, detail: string) { return value ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
/** One bounded journal orders every publication, promotion and retirement in a series. */
export class Publications {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
  private find(resource: string, values: Wire, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const model = self.engine.model.resource(p + resource), unique = model.uniques.find(u => !u.condition && u.fields.length === Object.keys(values).length && u.fields.every(f => Object.hasOwn(values, f)))!;
      const row = yield* (yield* Storage).findUnique(ctx.tenant, model, unique, self.engine.claimKey(model, unique, values)!, values);
      return row ? yield* self.call(resource + ".get", { id: row.id }, ctx) : null;
    }).pipe(Effect.provide(self.engine.layer));
  }
  private evidence(id: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () { if (id != null) { const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id }, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx); } });
  }
  register(input: RegisterCandidate, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.evidence(input.support, ctx);
      if (input.decisionCase) yield* check((yield* new Decisions(self.engine).state(input.decisionCase, ctx)).events.length === 0, "Candidate must pin its Decision before responses");
      return yield* self.call("ReleaseCandidate.create", { ...input, evaluationDefinition: input.evaluationDefinition ?? null, decisionCase: input.decisionCase ?? null, approvedOption: input.approvedOption ?? null, support: input.support ?? null }, ctx);
    });
  }
  attachEvaluation(candidate: string, run: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* check(!(yield* findTerminalFact(self.engine, "@forgegraph/foundation/evaluation/_/EvaluationStart", "run", run, ctx)), "Evaluation must be attached before execution");
      yield* check(!(yield* findTerminalFact(self.engine, "@forgegraph/foundation/evaluation/_/EvaluationFinish", "run", run, ctx)), "Evaluation is already terminal");
      return yield* self.call("CandidateEvaluation.create", { candidate, run }, ctx);
    });
  }
  private validate(candidate: Wire, evaluation: unknown, decision: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("PublicationSeries.get", { id: candidate.series }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: candidate.specification }, ctx);
      const artifact = yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", { id: candidate.artifact }, ctx);
      yield* check(artifact.specificationPin === candidate.specification, "Candidate artifact must pin its exact specification");
      yield* self.evidence(candidate.support, ctx);
      const needsEvaluation = candidate.policy === "EvaluationCompleted" || candidate.policy === "Both", needsDecision = candidate.policy === "DecisionApproved" || candidate.policy === "Both";
      yield* check(needsEvaluation === (evaluation != null) && needsDecision === (decision != null), "Selected qualification gates are incomplete");
      if (evaluation != null) {
        const finish = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: evaluation }, ctx);
        const run = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationRun.get", { id: finish.run }, ctx);
        const link = yield* self.find("CandidateEvaluation", { candidate: candidate.id }, ctx);
        const start = yield* findTerminalFact(self.engine, "@forgegraph/foundation/evaluation/_/EvaluationStart", "run", finish.run, ctx);
        yield* check(link && link.run === finish.run && start && Date.parse(String(link.createdAt)) <= Date.parse(String(start.startedAt)), "Evaluation was not bound to this candidate before execution");
        yield* check(finish.outcome === "Completed" && run.definition === candidate.evaluationDefinition, "Selected evaluation did not complete under the pinned definition");
        yield* self.evidence(finish.support, ctx);
      }
      if (decision != null) {
        const state = yield* new Decisions(self.engine).state(String(candidate.decisionCase), ctx);
        yield* check(state.outcome?.id === decision && state.outcome.selected === candidate.approvedOption, "Selected Decision did not approve publication");
        yield* check(state.events[0] && Date.parse(String(candidate.createdAt)) <= Date.parse(String(state.events[0].createdAt)), "Candidate was not pinned before Decision responses");
      }
    });
  }
  qualify(candidateId: string, input: { evaluation?: string; decision?: string }, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const candidate = yield* self.call("ReleaseCandidate.get", { id: candidateId }, ctx);
      yield* self.validate(candidate, input.evaluation, input.decision, ctx);
      return yield* self.call("CandidateQualification.create", { candidate: candidateId, policy: candidate.policy, evaluation: input.evaluation ?? null, decision: input.decision ?? null }, ctx);
    });
  }
  candidatePhase(id: string, ctx: CallContext): Effect.Effect<"Proposed" | "Qualifying" | "Qualified" | "Rejected", ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const candidate = yield* self.call("ReleaseCandidate.get", { id }, ctx);
      const qualification = yield* self.find("CandidateQualification", { candidate: id }, ctx);
      if (qualification) { yield* self.validate(candidate, qualification.evaluation, qualification.decision, ctx); return "Qualified"; }
      const evaluation = yield* self.find("CandidateEvaluation", { candidate: id }, ctx);
      if (evaluation) {
        const finish = yield* findTerminalFact(self.engine, "@forgegraph/foundation/evaluation/_/EvaluationFinish", "run", evaluation.run, ctx);
        if (finish && finish.outcome !== "Completed") return "Rejected";
      }
      if (candidate.decisionCase != null) {
        const state = yield* new Decisions(self.engine).state(String(candidate.decisionCase), ctx);
        if (state.terminal && state.outcome?.selected !== candidate.approvedOption) return "Rejected";
        if (state.events.length) return "Qualifying";
      }
      return evaluation ? "Qualifying" : "Proposed";
    });
  }
  private releaseRecord(id: unknown, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const release = yield* self.call("Release.get", { id }, ctx), candidate = yield* self.call("ReleaseCandidate.get", { id: release.candidate }, ctx), qualification = yield* self.call("CandidateQualification.get", { id: release.qualification }, ctx);
      yield* self.validate(candidate, qualification.evaluation, qualification.decision, ctx);
      return release;
    });
  }
  state(series: string, ctx: CallContext): Effect.Effect<PublicationState, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.call("PublicationSeries.get", { id: series }, ctx);
      const events: Wire[] = [], releases = new Map<string, { release: Wire; status: PublicationStatus }>(), channels = new Map<string, string>();
      for (let ordinal = 0; ordinal < 128; ordinal++) {
        const event = yield* self.find("Promotion", { series, ordinal }, ctx);
        if (!event) break;
        const releaseId = String(event.release), prior = releases.get(releaseId);
        yield* check((event.previous ?? null) === (events.at(-1)?.id ?? null), "Invalid publication journal chain");
        if (event.kind === "Published") {
          yield* check(!prior, "Release was already published");
          releases.set(releaseId, { release: yield* self.releaseRecord(releaseId, ctx), status: "Published" });
        } else {
          yield* check(prior && prior.status !== "Retired", "Release is not published or is retired");
          if (event.kind === "Promoted") yield* check(prior!.status === "Published", "Deprecated releases cannot be promoted");
          else if (event.kind === "Deprecated") { yield* check(prior!.status === "Published", "Release is already deprecated"); prior!.status = "Deprecated"; }
          else { yield* check(event.kind === "Retired", "Unknown publication event"); prior!.status = "Retired"; }
        }
        if (event.channel != null) {
          const channel = yield* self.call("PublicationChannel.get", { id: event.channel }, ctx);
          yield* self.engine.call("@forgegraph/foundation/participation/_/ParticipationSet.get", { id: channel.audience }, ctx);
          channels.set(String(channel.id), releaseId);
        }
        events.push(event);
      }
      return { events, releases, channels };
    });
  }
  private append(series: string, release: string, channel: string | null, kind: string, reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (ctx.idempotencyKey) {
        const previous = yield* self.find("Promotion", { commandKey: ctx.idempotencyKey }, ctx);
        if (previous) {
          yield* check(previous.series === series && previous.release === release && previous.channel === channel && previous.kind === kind && previous.reason === reason, "Publication command key reused with different inputs");
          return yield* self.call("Promotion.create", { series, release, channel, kind, reason, ordinal: previous.ordinal, previous: previous.previous, commandKey: ctx.idempotencyKey, recordedBy: previous.recordedBy }, ctx);
        }
      }
      const state = yield* self.state(series, ctx), current = state.releases.get(release);
      yield* check(state.events.length < 128, "Publication series journal is full");
      if (kind === "Published") { yield* check(!current, "Release already published"); yield* self.releaseRecord(release, ctx); }
      else yield* check(current && current.status !== "Retired" && (kind === "Retired" || current.status === "Published"), "Release is not eligible for this transition");
      return yield* self.call("Promotion.create", { series, release, channel, kind, reason, ordinal: state.events.length, previous: state.events.at(-1)?.id ?? null, commandKey: ctx.idempotencyKey ?? null, recordedBy: ctx.actor }, ctx);
    });
  }
  publish(candidateId: string, channel: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const candidate = yield* self.call("ReleaseCandidate.get", { id: candidateId }, ctx), qualification = yield* self.find("CandidateQualification", { candidate: candidateId }, ctx);
      yield* check(qualification, "Candidate has no qualification");
      yield* self.validate(candidate, qualification!.evaluation, qualification!.decision, ctx);
      let release = yield* self.find("Release", { candidate: candidateId }, ctx);
      if (!release) release = yield* self.call("Release.create", { series: candidate.series, candidate: candidateId, qualification: qualification!.id, specification: candidate.specification, artifact: candidate.artifact, recordedBy: ctx.actor }, { ...ctx, idempotencyKey: `publication:release:${candidateId}` });
      yield* self.append(String(candidate.series), String(release!.id), channel, "Published", "Published", ctx);
      return release!;
    });
  }
  promote(release: string, channel: string, reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { const row = yield* self.releaseRecord(release, ctx); return yield* self.append(String(row.series), release, channel, "Promoted", reason, ctx); }); }
  transition(release: string, kind: "Deprecated" | "Retired", reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { const row = yield* self.releaseRecord(release, ctx); return yield* self.append(String(row.series), release, null, kind, reason, ctx); }); }
  release(id: string, ctx: CallContext): Effect.Effect<{ release: Wire; status: PublicationStatus } | null, ForgeError> { const self = this; return Effect.gen(function* () { const row = yield* self.releaseRecord(id, ctx); return (yield* self.state(String(row.series), ctx)).releases.get(id) ?? null; }); }
  channel(id: string, ctx: CallContext): Effect.Effect<{ channel: Wire; release: Wire | null; status: PublicationStatus | null }, ForgeError> {
    const self = this;
    return Effect.gen(function* () { const channel = yield* self.call("PublicationChannel.get", { id }, ctx); yield* self.engine.call("@forgegraph/foundation/participation/_/ParticipationSet.get", { id: channel.audience }, ctx); const state = yield* self.state(String(channel.series), ctx), current = state.releases.get(state.channels.get(id) ?? ""); return { channel, release: current?.status === "Retired" ? null : current?.release ?? null, status: current?.status ?? null }; });
  }
  audience(promotion: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> { const self = this; return Effect.gen(function* () { const event = yield* self.call("Promotion.get", { id: promotion }, ctx); yield* self.state(String(event.series), ctx); yield* check(event.channel, "Lifecycle event has no audience"); const channel = yield* self.call("PublicationChannel.get", { id: event.channel }, ctx); return yield* self.call("ReleaseAudienceLink.create", { promotion, release: event.release, channel: channel.id, audience: channel.audience }, { ...ctx, idempotencyKey: `publication:audience:${promotion}` }); }); }
}
