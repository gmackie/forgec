import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Engine, CallContext } from "../engine.js";
import type { Wire } from "../decode.js";
import { err, type ForgeError } from "../errors.js";
import { Storage } from "../services.js";
import { Decisions } from "./decision.js";
import { Evidence } from "./evidence.js";
import { findTerminalFact } from "./facts.js";
const p = "@forgegraph/foundation/agreement-catalog/_/", pp = "@forgegraph/foundation/participation/_/", ep = "@forgegraph/foundation/entitlement/_/";
export interface PublishOffer {
  entry: string; supplier: string; terms: string; scope: string; validFrom: string; validUntil: string;
  document?: string; support?: string; evaluation?: string; right?: string; requirement?: string; previous?: string;
}
export interface AcceptAgreement {
  acceptanceKey: string; offer: string; customer: string; supplierParticipation: string; customerParticipation: string;
  decisionCase: string; approvedOption: string; expectedTerms: string; expectedDocument?: string;
  validFrom: string; validUntil: string; predecessor?: string; change?: "Original" | "Renewal" | "Amendment";
}
export interface AgreementState { agreement: Wire; issuance: Wire | null; events: Wire[]; phase: "NotAccepted" | "PendingIssuance" | "Scheduled" | "Active" | "Expired" | "Suspended" | "Terminated" }
function check(value: unknown, detail: string) { return value ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
/** Immutable acceptance followed by durable, idempotent issuance stages. */
export class AgreementCatalog {
  constructor(private readonly engine: Engine) {}
  private call(op: string, body: Wire, ctx: CallContext) { return this.engine.call(p + op, body, ctx); }
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
    return Effect.gen(function* () {
      if (id == null) return;
      const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id }, ctx);
      yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    });
  }
  private offer(id: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const offer = yield* self.call("Offer.get", { id }, ctx);
      const entry = yield* self.call("CatalogEntry.get", { id: offer.entry }, ctx);
      yield* self.call("Catalog.get", { id: entry.catalog }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: entry.specification }, ctx);
      yield* self.engine.call("@forgegraph/foundation/specification/_/SpecificationPin.get", { id: offer.terms }, ctx);
      yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: offer.supplier }, ctx);
      yield* self.engine.call(ep + "EntitlementScope.get", { id: offer.scope }, ctx);
      if (offer.document != null) {
        const document = yield* self.engine.call("@forgegraph/foundation/artifact/_/ArtifactRevision.get", { id: offer.document }, ctx);
        yield* check(document.specificationPin === offer.terms, "Offer document does not pin the terms");
      }
      yield* self.evidence(offer.support, ctx);
      if (offer.evaluation != null) {
        const evaluation = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: offer.evaluation }, ctx);
        yield* self.evidence(evaluation.support, ctx);
      }
      if (offer.right != null) yield* self.engine.call(ep + "RightDefinition.get", { id: offer.right }, ctx);
      if (offer.requirement != null) yield* self.engine.call(ep + "RequirementDefinition.get", { id: offer.requirement }, ctx);
      return offer;
    });
  }
  publish(input: PublishOffer, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const previous = input.previous ? yield* self.offer(input.previous, ctx) : null;
      yield* self.evidence(input.support, ctx);
      return yield* self.call("Offer.create", { ...input, previous: input.previous ?? null, revision: previous ? Number(previous.revision) + 1 : 1, document: input.document ?? null, support: input.support ?? null, evaluation: input.evaluation ?? null, right: input.right ?? null, requirement: input.requirement ?? null }, ctx);
    });
  }
  select(offer: string, decisionCase: string, approvedOption: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.offer(offer, ctx);
      const state = yield* new Decisions(self.engine).state(decisionCase, ctx);
      yield* check(!state.terminal && state.events.length === 0, "Selection must pin the offer before responses are collected");
      return yield* self.call("OfferQualification.create", { offer, decisionCase, approvedOption }, ctx);
    });
  }
  qualify(decisionCase: string, approvedOption: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const decision = yield* new Decisions(self.engine).state(decisionCase, ctx);
      yield* check(decision.outcome != null && decision.outcome.selected === approvedOption, "Qualification requires the expected approved Decision outcome");
      return decision.outcome!;
    });
  }
  accept(input: AcceptAgreement, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const offer = yield* self.offer(input.offer, ctx), approval = yield* self.qualify(input.decisionCase, input.approvedOption, ctx);
      const qualification = yield* self.find("OfferQualification", { decisionCase: input.decisionCase }, ctx);
      yield* check(qualification?.offer === input.offer && qualification?.approvedOption === input.approvedOption, "Decision was not selected for this offer and approval option");
      yield* self.signers(approval, input.supplierParticipation, input.customerParticipation, ctx);
      yield* check(offer.terms === input.expectedTerms && (offer.document ?? null) === (input.expectedDocument ?? null), "Offer terms drifted from the expected exact pins");
      const supplierEnd = yield* findTerminalFact(self.engine, pp + "ParticipationEnd", "participation", input.supplierParticipation, ctx);
      const customerEnd = yield* findTerminalFact(self.engine, pp + "ParticipationEnd", "participation", input.customerParticipation, ctx);
      if (input.predecessor) yield* self.state(input.predecessor, input.validFrom, ctx);
      return yield* self.call("Agreement.create", { acceptanceKey: input.acceptanceKey, offer: input.offer, supplier: offer.supplier, customer: input.customer, supplierParticipation: input.supplierParticipation, customerParticipation: input.customerParticipation, qualification: qualification!.id, supplierEnd: supplierEnd?.id ?? null, customerEnd: customerEnd?.id ?? null, approvalOption: input.approvedOption, approval: approval.id, terms: offer.terms, document: offer.document, validFrom: input.validFrom, validUntil: input.validUntil, predecessor: input.predecessor ?? null, change: input.change ?? "Original", recordedBy: ctx.actor }, { ...ctx, idempotencyKey: `agreement:accept:${input.acceptanceKey}` });
    });
  }
  private signers(approval: Wire, supplier: unknown, customer: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* new Decisions(self.engine).state(String(approval.decisionCase), ctx);
      yield* check(state.outcome?.id === approval.id, "Agreement references an unselected or invalid Decision candidate");
      const qualification = yield* self.find("OfferQualification", { decisionCase: approval.decisionCase }, ctx);
      yield* check(qualification && state.events[0] && Date.parse(String(qualification.createdAt)) <= Date.parse(String(state.events[0].createdAt)), "Offer selection must precede decision responses");
      const selected = state.options.find(option => option.id === approval.selected)!;
      yield* check(supplier !== customer && [supplier, customer].every(voter => state.responses.some(response => response.voter === voter && (response.ranking as number[])[0] === selected.ordinal)), "Both signers must approve the selected terms through Decision");
    });
  }
  private validateAgreement(id: string, ctx: CallContext): Effect.Effect<{ agreement: Wire; offer: Wire }, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const agreement = yield* self.call("Agreement.get", { id }, ctx), offer = yield* self.offer(String(agreement.offer), ctx);
      yield* self.call("OfferQualification.get", { id: agreement.qualification }, ctx);
      const approval = yield* self.engine.call("@forgegraph/foundation/decision/_/DecisionOutcome.get", { id: agreement.approval }, ctx);
      yield* self.signers(approval, agreement.supplierParticipation, agreement.customerParticipation, ctx);
      for (const side of ["supplier", "customer"]) {
        yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: agreement[side] }, ctx);
        const membership = yield* self.engine.call(pp + "Participation.get", { id: agreement[side + "Participation"] }, ctx);
        yield* check(membership.participant === agreement[side], "Agreement signer does not represent its Party");
        if (agreement[side + "End"] != null) yield* self.engine.call(pp + "ParticipationEnd.get", { id: agreement[side + "End"] }, ctx);
      }
      return { agreement, offer };
    });
  }
  /** Receipt keys derive from immutable acceptance identity, never from a retry's request ID.
   * A failed stage leaves acceptance inspectable and can safely resume the same stage. */
  issue(agreementId: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const { agreement, offer } = yield* self.validateAgreement(agreementId, ctx);
      const completed = yield* self.find("AgreementIssued", { agreement: agreementId }, ctx);
      if (completed) return completed;
      const stage = (suffix: string) => ({ ...ctx, idempotencyKey: `agreement:${agreementId}:${suffix}` });
      const terms = yield* self.call("AgreementTermLink.create", { agreement: agreementId, specification: agreement.terms, artifact: agreement.document }, stage("terms"));
      const supplier = yield* self.call("AgreementParticipant.create", { agreement: agreementId, side: "Supplier", participant: agreement.supplierParticipation }, stage("supplier"));
      const customer = yield* self.call("AgreementParticipant.create", { agreement: agreementId, side: "Customer", participant: agreement.customerParticipation }, stage("customer"));
      let right: Wire | null = yield* self.find("AgreementEntitlementLink", { agreement: agreementId }, ctx);
      let duty: Wire | null = yield* self.find("AgreementObligationLink", { agreement: agreementId }, ctx);
      if (offer.right != null && !right) {
        const entitlement = yield* self.engine.call(ep + "Entitlement.create", { holder: agreement.customer, right: offer.right, scope: offer.scope, validFrom: agreement.validFrom, validUntil: agreement.validUntil, quantity: null, unit: null, predecessor: null, recordedBy: agreement.recordedBy, reason: `Agreement ${agreementId}` }, stage("grant"));
        right = yield* self.call("AgreementEntitlementLink.create", { agreement: agreementId, offer: offer.id, entitlement: entitlement.id }, stage("right-link"));
      }
      if (offer.requirement != null && !duty) {
        const obligation = yield* self.engine.call(ep + "Obligation.create", { obligatedParty: agreement.customer, requirement: offer.requirement, scope: offer.scope, incurredAt: agreement.validFrom, dueAt: agreement.validUntil, quantity: null, unit: null, recordedBy: agreement.recordedBy, reason: `Agreement ${agreementId}` }, stage("duty"));
        duty = yield* self.call("AgreementObligationLink.create", { agreement: agreementId, offer: offer.id, obligation: obligation.id }, stage("duty-link"));
      }
      return yield* self.call("AgreementIssued.create", { agreement: agreementId, offer: offer.id, terms: terms.id, supplier: supplier.id, customer: customer.id, right: right?.id ?? null, duty: duty?.id ?? null }, stage("complete"));
    });
  }
  state(agreementId: string, at: string, ctx: CallContext): Effect.Effect<AgreementState, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const instant = yield* Effect.try({ try: () => Date.parse(decodeDatetime(at)), catch: () => err("ValidationFailed", "Invalid agreement query instant") });
      const { agreement } = yield* self.validateAgreement(agreementId, ctx), issuance = yield* self.find("AgreementIssued", { agreement: agreementId }, ctx);
      if (issuance) {
        yield* self.call("AgreementTermLink.get", { id: issuance.terms }, ctx);
        yield* self.call("AgreementParticipant.get", { id: issuance.supplier }, ctx);
        yield* self.call("AgreementParticipant.get", { id: issuance.customer }, ctx);
        if (issuance.right != null) {
          const link = yield* self.call("AgreementEntitlementLink.get", { id: issuance.right }, ctx);
          yield* self.engine.call(ep + "Entitlement.get", { id: link.entitlement }, ctx);
        }
        if (issuance.duty != null) {
          const link = yield* self.call("AgreementObligationLink.get", { id: issuance.duty }, ctx);
          yield* self.engine.call(ep + "Obligation.get", { id: link.obligation }, ctx);
        }
      }
      const events: Wire[] = [];
      for (let ordinal = 0; ordinal < 32; ordinal++) {
        const event = yield* self.find("AgreementEvent", { agreement: agreementId, ordinal }, ctx);
        if (!event) break;
        events.push(event);
      }
      const last = events.filter(e => Date.parse(String(e.createdAt)) <= instant).at(-1);
      const phase = instant < Date.parse(String(agreement.createdAt)) ? "NotAccepted" : last?.kind === "Terminated" ? "Terminated" : instant >= Date.parse(String(agreement.validUntil)) ? "Expired" : last?.kind === "Suspended" ? "Suspended" : !issuance || instant < Date.parse(String(issuance.createdAt)) ? "PendingIssuance" : instant < Date.parse(String(agreement.validFrom)) ? "Scheduled" : "Active";
      return { agreement, issuance, events, phase };
    });
  }
  /** Agreement-aware use of rights; suspension does not rewrite independent substrate grants. */
  rightsAt(agreement: string, at: string, ctx: CallContext): Effect.Effect<Wire[], ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.state(agreement, at, ctx);
      if (state.phase !== "Active" || state.issuance?.right == null) return [];
      const link = yield* self.call("AgreementEntitlementLink.get", { id: state.issuance.right }, ctx);
      const right = yield* self.engine.call(ep + "Entitlement.get", { id: link.entitlement }, ctx);
      const end = yield* findTerminalFact(self.engine, ep + "EntitlementEnd", "entitlement", right.id, ctx);
      return end && Date.parse(String(end.effectiveAt)) <= Date.parse(at) ? [] : [right];
    });
  }
  transition(agreement: string, kind: "Suspended" | "Resumed" | "Terminated", reason: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.state(agreement, "9999-01-01T00:00:00Z", ctx);
      const { idempotencyKey: _key, ...context } = ctx;
      return yield* self.call("AgreementEvent.create", { agreement, ordinal: state.events.length, previous: state.events.at(-1)?.id ?? null, kind, reason, recordedBy: ctx.actor }, context);
    });
  }
}
