import { Effect } from "effect";
import { decodeDatetime } from "../codecs.js";
import type { Wire } from "../decode.js";
import { sha256, stableJson, type Engine, type CallContext } from "../engine.js";
import { err, type ForgeError } from "../errors.js";
import { Storage } from "../services.js";
import { findTerminalFact } from "./facts.js";
import { Evidence } from "./evidence.js";
const p = "@forgegraph/foundation/decision/_/", participation = "@forgegraph/foundation/participation/_/";
export type DecisionRule = "Single" | "First" | "Quorum" | "Unanimous" | "ChooseOne" | "Ranked";
export interface OpenDecision {
  participationSet: string; eligibilityAt: string; electors: readonly string[];
  rule: DecisionRule; threshold?: number; options: readonly string[]; deadline: string;
  support?: string; evaluation?: string; reconsideration?: string;
}
export interface DecisionState { decisionCase: Wire; events: Wire[]; responses: Wire[]; options: Wire[]; terminal: Wire | null; outcome: Wire | null }
function valid(condition: unknown, detail: string): Effect.Effect<void, ForgeError> { return condition ? Effect.void : Effect.fail(err("ValidationFailed", detail)); }
/** A bounded append-only command journal is the serialization guard. Candidates have no
 * authority until selected by a journal event; only state() returns a validated outcome. */
export class Decisions {
  constructor(private readonly engine: Engine) {}
  private call(operation: string, body: Wire, ctx: CallContext) { return ctx.idempotencyKey && operation.endsWith(".create")
    ? Effect.flatMap(Effect.promise(() => sha256(stableJson({ operation, stage: body.depth ?? body.ordinal ?? null }))), digest => this.engine.call(p + operation, body, { ...ctx, idempotencyKey: `${ctx.idempotencyKey}:${digest}` }))
    : this.engine.call(p + operation, body, ctx); }
  private find(resource: string, params: Wire, ctx: CallContext): Effect.Effect<Wire | null, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const model = self.engine.model.resource(p + resource);
      const unique = model.uniques.find(u => u.fields.length === Object.keys(params).length && u.fields.every(f => Object.hasOwn(params, f)) && !u.condition)!;
      const key = self.engine.claimKey(model, unique, params)!;
      const row = yield* (yield* Storage).findUnique(ctx.tenant, model, unique, key, params);
      // Never confuse a hidden existing event with the end of the journal.
      return row ? yield* self.call(resource + ".get", { id: row.id }, ctx) : null;
    }).pipe(Effect.provide(self.engine.layer));
  }
  private support(id: unknown, ctx: CallContext): Effect.Effect<void, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      if (id == null) return;
      const seal = yield* self.engine.call("@forgegraph/foundation/evidence/_/EvidenceSeal.get", { id }, ctx);
      yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
    });
  }
  open(input: OpenDecision, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      yield* valid(input.electors.length >= 1 && input.electors.length <= 16 && input.options.length >= 1 && input.options.length <= 16, "Decision requires 1..16 electors and options");
      const at = yield* Effect.try({ try: () => Date.parse(decodeDatetime(input.eligibilityAt)), catch: () => err("ValidationFailed", "Invalid eligibility instant") });
      const threshold = input.threshold ?? (input.rule === "Unanimous" ? input.electors.length : 1);
      yield* validateRule(input.rule, threshold, input.electors.length, input.options.length);
      if (input.reconsideration) yield* valid((yield* self.state(input.reconsideration, ctx)).terminal != null, "Reconsideration requires a terminal case");
      yield* self.support(input.support, ctx);
      if (input.evaluation) {
        const finish = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: input.evaluation }, ctx);
        yield* self.support(finish.support, ctx);
      }
      const members: { id: string; end: string | null }[] = [], parties = new Set<string>();
      for (const id of input.electors) {
        const row = yield* self.engine.call(participation + "Participation.get", { id }, ctx);
        const end = yield* findTerminalFact(self.engine, participation + "ParticipationEnd", "participation", id, ctx);
        yield* valid(row.participationSet === input.participationSet && at >= Date.parse(row.validFrom) && (row.validUntil == null || at < Date.parse(row.validUntil)) && (!end || at < Date.parse(String(end.effectiveAt))), "Elector is not eligible at the pinned instant");
        yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: row.participant }, ctx);
        yield* valid(!parties.has(String(row.participant)), "A Party may occupy only one electorate slot"); parties.add(String(row.participant));
        members.push({ id, end: end ? String(end.id) : null });
      }
      let head: string | null = null, depth = 0;
      for (const member of members.toReversed()) {
        const node: Wire = yield* self.call("DecisionElector.create", { participation: member.id, ended: member.end, next: head, depth: ++depth }, ctx);
        head = String(node.id);
      }
      const record = yield* self.call("DecisionCase.create", { participationSet: input.participationSet, eligibilityAt: input.eligibilityAt, electors: head, rule: input.rule, ruleVersion: "decision-rule/1", threshold, optionCount: input.options.length, deadline: input.deadline, support: input.support ?? null, evaluation: input.evaluation ?? null, reconsideration: input.reconsideration ?? null }, ctx);
      for (const [ordinal, label] of input.options.entries()) yield* self.call("DecisionOption.create", { decisionCase: record.id, ordinal, label }, ctx);
      return record;
    });
  }
  private electorate(record: Wire, ctx: CallContext): Effect.Effect<Set<string>, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const ids = new Set<string>(), parties = new Set<string>(); let id: unknown = record.electors;
      const at = Date.parse(String(record.eligibilityAt));
      while (id != null) {
        yield* valid(ids.size < 16, "Electorate exceeds bound");
        const node: Wire = yield* self.call("DecisionElector.get", { id }, ctx);
        const row = yield* self.engine.call(participation + "Participation.get", { id: node.participation }, ctx);
        const end = node.ended == null ? null : yield* self.engine.call(participation + "ParticipationEnd.get", { id: node.ended }, ctx);
        yield* valid(!ids.has(String(row.id)) && !parties.has(String(row.participant)) && row.participationSet === record.participationSet && at >= Date.parse(row.validFrom) && (row.validUntil == null || at < Date.parse(row.validUntil)) && (!end || at < Date.parse(end.effectiveAt)), "Invalid pinned electorate");
        yield* self.engine.call("@forgegraph/foundation/party/_/Party.get", { id: row.participant }, ctx);
        ids.add(String(row.id)); parties.add(String(row.participant)); id = node.next;
      }
      return ids;
    });
  }
  state(decisionCase: string, ctx: CallContext): Effect.Effect<DecisionState, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const record = yield* self.call("DecisionCase.get", { id: decisionCase }, ctx);
      const electors = yield* self.electorate(record, ctx);
      yield* validateRule(record.rule as DecisionRule, Number(record.threshold), electors.size, Number(record.optionCount));
      yield* self.support(record.support, ctx);
      if (record.evaluation != null) {
        const finish = yield* self.engine.call("@forgegraph/foundation/evaluation/_/EvaluationFinish.get", { id: record.evaluation }, ctx);
        yield* self.support(finish.support, ctx);
      }
      const options: Wire[] = [];
      for (let ordinal = 0; ordinal < Number(record.optionCount); ordinal++) {
        const option = yield* self.find("DecisionOption", { decisionCase, ordinal }, ctx);
        yield* valid(option != null, "Decision options are incomplete"); options.push(option!);
      }
      const events: Wire[] = [], active = new Map<string, Wire>(), seen = new Set<string>();
      let terminal: Wire | null = null, outcome: Wire | null = null;
      for (let ordinal = 0; ordinal < 64; ordinal++) {
        const event = yield* self.find("DecisionEvent", { decisionCase, ordinal }, ctx);
        if (!event) break;
        yield* valid(!terminal && (event.previous ?? null) === (events.at(-1)?.id ?? null), "Invalid decision journal chain");
        if (event.kind === "Responded") {
          const response = yield* self.call("DecisionResponse.get", { id: event.response }, ctx);
          yield* valid(response.decisionCase === decisionCase && electors.has(String(response.voter)) && !seen.has(String(response.voter)), "Invalid or duplicate voter response");
          yield* validRanking(response.ranking, record.rule as DecisionRule, options.length);
          yield* self.support(response.support, ctx);
          seen.add(String(response.voter)); active.set(String(response.id), response);
        } else if (event.kind === "Withdrawn") {
          yield* valid(active.has(String(event.response)), "Withdrawal requires an active response"); active.delete(String(event.response));
        } else {
          terminal = event;
          if (event.kind === "Finalized") {
            outcome = yield* self.call("DecisionOutcome.get", { id: event.outcome }, ctx);
            const responses = [...active.values()];
            const winner = yield* choose(record, electors.size, responses, options.length);
            yield* valid(outcome!.decisionCase === decisionCase && outcome!.selected === options[winner]!.id, "Outcome does not match rule result");
            const digest = yield* Effect.promise(() => sha256(stableJson({ decisionCase, responses: responses.map(r => r.id), previous: event.previous, selected: outcome!.selected })));
            yield* valid(digest === outcome!.snapshotDigest, "Outcome snapshot digest mismatch");
            const selected: string[] = []; let current: unknown = outcome!.responses;
            while (current != null) {
              yield* valid(selected.length < 16, "Outcome response snapshot exceeds bound");
              const member = yield* self.call("DecisionOutcomeMember.get", { id: current }, ctx);
              selected.push(String(member.response)); current = member.next;
            }
            yield* valid(stableJson(selected) === stableJson(responses.map(r => r.id)), "Outcome response snapshot differs from journal");
          } else yield* valid(event.kind === "Expired", "Unknown decision event");
        }
        events.push(event);
      }
      return { decisionCase: record, events, responses: [...active.values()], options, terminal, outcome };
    });
  }
  private append(state: DecisionState, kind: string, response: unknown, outcome: unknown, ctx: CallContext) {
    if (state.terminal || state.events.length >= 64) return Effect.fail(err("InvalidTransition", "Decision is terminal or its journal is full"));
    return this.call("DecisionEvent.create", { decisionCase: state.decisionCase.id, ordinal: state.events.length, previous: state.events.at(-1)?.id ?? null, kind, response, outcome, recordedBy: ctx.actor }, ctx);
  }
  respond(decisionCase: string, voter: string, ranking: readonly number[], ctx: CallContext, support?: string): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.state(decisionCase, ctx);
      yield* valid(!state.terminal && (yield* self.electorate(state.decisionCase, ctx)).has(voter), "Decision is terminal or voter is not eligible");
      yield* validRanking(ranking, state.decisionCase.rule as DecisionRule, state.options.length);
      yield* self.support(support, ctx);
      let response = yield* self.find("DecisionResponse", { decisionCase, voter }, ctx);
      if (response) yield* valid(stableJson(response.ranking) === stableJson(ranking) && (response.support ?? null) === (support ?? null), "A voter cannot replace its immutable response");
      else response = yield* self.call("DecisionResponse.create", { decisionCase, voter, ranking: [...ranking], support: support ?? null, recordedBy: ctx.actor }, ctx);
      const accepted = state.events.find(e => e.kind === "Responded" && e.response === response!.id);
      if (accepted) return accepted;
      return yield* self.append(state, "Responded", response!.id, null, ctx);
    });
  }
  withdraw(decisionCase: string, response: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () { const state = yield* self.state(decisionCase, ctx); const withdrawn = state.events.find(e => e.kind === "Withdrawn" && e.response === response); if (withdrawn) return withdrawn; yield* valid(state.responses.some(r => r.id === response), "Response is not active"); return yield* self.append(state, "Withdrawn", response, null, ctx); });
  }
  finalize(decisionCase: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this;
    return Effect.gen(function* () {
      const state = yield* self.state(decisionCase, ctx);
      if (state.outcome) return state.outcome;
      yield* valid(!state.terminal, "Decision is already terminal");
      const winner = yield* choose(state.decisionCase, (yield* self.electorate(state.decisionCase, ctx)).size, state.responses, state.options.length);
      let head: string | null = null, depth = 0;
      for (const response of state.responses.toReversed()) { const member: Wire = yield* self.call("DecisionOutcomeMember.create", { response: response.id, next: head, depth: ++depth }, ctx); head = String(member.id); }
      const selected = state.options[winner]!.id;
      const snapshotDigest = yield* Effect.promise(() => sha256(stableJson({ decisionCase, responses: state.responses.map(r => r.id), previous: state.events.at(-1)?.id ?? null, selected })));
      const outcome = yield* self.call("DecisionOutcome.create", { decisionCase, selected, responses: head, snapshotDigest }, ctx);
      yield* self.append(state, "Finalized", null, outcome.id, ctx);
      return outcome;
    });
  }
  expire(decisionCase: string, ctx: CallContext): Effect.Effect<Wire, ForgeError> {
    const self = this; return Effect.gen(function* () { const state = yield* self.state(decisionCase, ctx); if (state.terminal?.kind === "Expired") return state.terminal; return yield* self.append(state, "Expired", null, null, ctx); });
  }
}
function validateRule(rule: DecisionRule, threshold: number, electors: number, options: number) {
  return valid(["Single", "First", "Quorum", "Unanimous", "ChooseOne", "Ranked"].includes(rule) && Number.isInteger(threshold) && threshold >= 1 && threshold <= electors && ((rule !== "Single" && rule !== "ChooseOne") || electors === 1) && (rule !== "ChooseOne" || options >= 2) && (rule !== "Unanimous" || threshold === electors) && (!["Single", "First", "ChooseOne"].includes(rule) || threshold === 1), "Invalid pinned decision rule configuration");
}
function validRanking(ranking: unknown, rule: DecisionRule, options: number) {
  return valid(Array.isArray(ranking) && ranking.length === (rule === "Ranked" ? options : 1) && new Set(ranking).size === ranking.length && ranking.every(x => Number.isInteger(x) && x >= 0 && x < options), "Invalid option selection or ranking");
}
function choose(record: Wire, electors: number, responses: Wire[], options: number): Effect.Effect<number, ForgeError> {
  return Effect.gen(function* () {
    yield* valid(responses.length >= Number(record.threshold), "Decision threshold has not been reached");
    if (record.rule === "Unanimous") yield* valid(responses.length === electors && responses.every(r => (r.ranking as number[])[0] === (responses[0]!.ranking as number[])[0]), "Decision is not unanimous");
    if (["First", "Single", "ChooseOne", "Unanimous"].includes(String(record.rule))) return (responses[0]!.ranking as number[])[0]!;
    const scores = Array<number>(options).fill(0);
    for (const response of responses) for (const [position, ordinal] of (response.ranking as number[]).entries()) scores[ordinal]! += record.rule === "Ranked" ? options - position : 1;
    return scores.indexOf(Math.max(...scores));
  });
}
