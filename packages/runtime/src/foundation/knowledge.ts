import { Effect } from "effect";
import { Clock } from "../services.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Publications } from "./publication.js";
import { Artifacts } from "./artifact.js";
import { findTerminalFact } from "./facts.js";
const p = "@forgegraph/foundation/knowledge/_/", ep = "@forgegraph/foundation/entitlement/_/", pp = "@forgegraph/foundation/participation/_/", cp = "@forgegraph/foundation/classification/_/";
export interface KnowledgeAccess { entitlement: string; participation: string }
export interface CreateKnowledgeRevision { item: string; specification: string; content: string; classifications: readonly string[]; assessmentDefinition: string; previous?: string }
function check(value: unknown, detail: string) { return value ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
/** Exact edition facts; user-facing access combines entitlement, audience and independent Engine policy. */
export class Knowledge {
  constructor(private readonly engine: Engine) {}
  private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
  createRevision(input: CreateKnowledgeRevision, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* check(input.classifications.length >= 1 && input.classifications.length <= 16, "Knowledge requires 1..16 exact classification assignments");
      const previous = input.previous ? yield* self.call("KnowledgeRevision.get", { id: input.previous }, ctx) : null;
      const meanings = new Set<unknown>(); let head: string | null = null, depth = 0;
      for (const assignment of input.classifications.toReversed()) {
        const fact = yield* self.engine.call(cp + "ClassificationAssignment.get", { id: assignment }, ctx);
        yield* self.engine.call(cp + "ConceptRevision.get", { id: fact.meaning }, ctx);
        yield* check(!meanings.has(fact.meaning), "Duplicate knowledge classification meaning"); meanings.add(fact.meaning);
        const node: Wire = yield* self.call("KnowledgeClassification.create", { assignment, next: head, depth: ++depth }, ctx.idempotencyKey ? { ...ctx, idempotencyKey: `${ctx.idempotencyKey}:classification:${depth}` } : ctx);
        head = String(node.id);
      }
      return yield* self.call("KnowledgeRevision.create", { item: input.item, specification: input.specification, content: input.content, assessmentDefinition: input.assessmentDefinition, classifications: head, previous: input.previous ?? null, revision: previous ? Number(previous.revision) + 1 : 1 }, ctx);
    });
  }
  meanings(revisionId: string, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const revision = yield* self.call("KnowledgeRevision.get", { id: revisionId }, ctx), result: Wire[] = [], seen = new Set<unknown>();
      let id: unknown = revision.classifications;
      while (id != null) {
        yield* check(result.length < 16, "Classification snapshot exceeds bound");
        const node: Wire = yield* self.call("KnowledgeClassification.get", { id }, ctx);
        const assignment = yield* self.engine.call(cp + "ClassificationAssignment.get", { id: node.assignment }, ctx);
        const meaning = yield* self.engine.call(cp + "ConceptRevision.get", { id: assignment.meaning }, ctx);
        yield* self.engine.call(cp + "Taxonomy.get", { id: meaning.taxonomy }, ctx);
        yield* check(!seen.has(meaning.id), "Duplicate meaning in classification snapshot"); seen.add(meaning.id); result.push(meaning); id = node.next;
      }
      return result;
    });
  }
  publish(revision: string, audience: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.meanings(revision, ctx);
      const link = yield* self.engine.call("@forgegraph/foundation/publication/_/ReleaseAudienceLink.get", { id: audience }, ctx);
      const release = yield* new Publications(self.engine).release(String(link.release), ctx);
      yield* check(release?.status === "Published", "Knowledge publication requires a currently published qualified release");
      return yield* self.call("KnowledgePublication.create", { revision, audience, release: link.release }, ctx);
    });
  }
  history(editionId: string, ctx: CallContext): Effect.Effect<{ edition: Wire; revision: Wire; meanings: Wire[]; status: "Published" | "Deprecated" | "Retired" }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const edition = yield* self.call("KnowledgePublication.get", { id: editionId }, ctx), revision = yield* self.call("KnowledgeRevision.get", { id: edition.revision }, ctx);
      yield* self.call("KnowledgeItem.get", { id: revision.item }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: revision.specification }, ctx);
      yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", { id: revision.content }, ctx);
      yield* self.engine.call("@forgegraph/foundation/publication/_/ReleaseAudienceLink.get", { id: edition.audience }, ctx);
      const release = yield* new Publications(self.engine).release(String(edition.release), ctx);
      yield* check(release, "Knowledge edition references an unpublished release candidate");
      return { edition, revision, meanings: yield* self.meanings(String(revision.id), ctx), status: release!.status };
    });
  }
  resolve(editionId: string, access: KnowledgeAccess, ctx: CallContext): Effect.Effect<{ edition: Wire; revision: Wire; meanings: Wire[]; status: "Published" | "Deprecated" | "Retired" }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = Date.parse(yield* Effect.gen(function* () { return (yield* Clock).now(); }).pipe(Effect.provide(self.engine.layer)));
      const history = yield* self.history(editionId, ctx);
      yield* check(history.status !== "Retired" && Date.parse(String(history.edition.createdAt)) <= instant, "Knowledge edition is not available");
      const item = yield* self.call("KnowledgeItem.get", { id: history.revision.item }, ctx);
      const grant = yield* self.engine.call(ep + "Entitlement.get", { id: access.entitlement }, ctx);
      const end = yield* findTerminalFact(self.engine, ep + "EntitlementEnd", "entitlement", grant.id, ctx);
      yield* check(grant.right === item.accessRight && grant.scope === item.scope && instant >= Date.parse(String(grant.validFrom)) && (grant.validUntil == null || instant < Date.parse(String(grant.validUntil))) && (!end || instant < Date.parse(String(end.effectiveAt))), "Knowledge access entitlement is absent, expired or revoked");
      yield* self.engine.call(ep + "RightDefinition.get", { id: grant.right }, ctx);
      yield* self.engine.call(ep + "EntitlementScope.get", { id: grant.scope }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: grant.holder }, ctx);
      const audience = yield* self.engine.call("@forgegraph/foundation/publication/_/ReleaseAudienceLink.get", { id: history.edition.audience }, ctx);
      const member = yield* self.engine.call(pp + "Participation.get", { id: access.participation }, ctx);
      const memberEnd = yield* findTerminalFact(self.engine, pp + "ParticipationEnd", "participation", member.id, ctx);
      yield* check(member.participant === grant.holder && member.participationSet === audience.audience && instant >= Date.parse(String(member.validFrom)) && (member.validUntil == null || instant < Date.parse(String(member.validUntil))) && (!memberEnd || instant < Date.parse(String(memberEnd.effectiveAt))), "Knowledge audience membership is not effective for the entitlement holder");
      return history;
    });
  }
  download(edition: string, access: KnowledgeAccess, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this; return Effect.gen(function* () { const result = yield* self.resolve(edition, access, ctx); return yield* new Artifacts(self.engine).download(String(result.revision.content), ctx); });
  }
  feedback(edition: string, run: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const history = yield* self.history(edition, ctx);
      yield* check(history.status !== "Retired", "Retired editions cannot receive new feedback evaluations");
      yield* check(!(yield* findTerminalFact(self.engine, "@forgegraph/foundation/evaluation/_/EvaluationStart", "run", run, ctx)) && !(yield* findTerminalFact(self.engine, "@forgegraph/foundation/evaluation/_/EvaluationFinish", "run", run, ctx)), "Feedback must bind its edition before evaluation execution");
      return yield* self.call("KnowledgeFeedback.create", { edition, revision: history.revision.id, run }, ctx);
    });
  }
  finishFeedback(feedbackId: string, finishId: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const feedback = yield* self.call("KnowledgeFeedback.get", { id: feedbackId }, ctx);
      yield* self.history(String(feedback.edition), ctx);
      const finish = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: finishId }, ctx);
      if (finish.start != null) {
        const start = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationStart.get", { id: finish.start }, ctx);
        yield* check(Date.parse(String(start.startedAt)) >= Date.parse(String(feedback.createdAt)), "Feedback execution predates its edition binding");
      }
      return yield* self.call("KnowledgeFeedbackResult.create", { feedback: feedbackId, finish: finishId }, ctx);
    });
  }
}
