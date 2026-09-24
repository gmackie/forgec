import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { Storage } from '../services.js';
import { decodeDatetime } from '../codecs.js';
import { err, type ForgeError } from '../errors.js';
import { Evidence } from './evidence.js';
import { Evaluations } from './evaluation.js';
import { Decisions } from './decision.js';
import { Collaborations } from './collaboration.js';
import { Fulfillments } from './fulfillment.js';
const p = '@forgegraph/foundation/case-management/_/';
export type CaseAction = 'file' | 'interaction' | 'decision' | 'work' | 'milestone' | 'transfer' | 'relate' | 'escalate' | 'close' | 'reopen';
export interface CaseState { row: Wire; events: Wire[]; closed: boolean; owner: string; head: string | null }
export class Cases {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const seal = yield* self.engine.call('@forgegraph/foundation/evidence/_/EvidenceSeal.get', { id }, ctx);
   yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx);
  });
 }
 private detail(event: Wire, ctx: CallContext): Effect.Effect<void, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id: event.owner }, ctx);
   if (event.file) {
    const file = yield* self.call('CaseFile.get', { id: event.file }, ctx);
    if (file.evidence) yield* self.support(file.evidence, ctx);
    if (file.document) yield* self.engine.call('@forgegraph/foundation/artifact/_/ArtifactRevision.get', { id: file.document }, ctx);
   }
   if (event.interaction) {
    const interaction = yield* self.call('CaseInteraction.get', { id: event.interaction }, ctx);
    yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: interaction.purpose }, ctx);
    yield* new Collaborations(self.engine).activity(String(interaction.discussion), ctx);
   }
   if (event.decision) yield* new Decisions(self.engine).state(String(event.decision), ctx);
   if (event.work) yield* new Fulfillments(self.engine).status(String(event.work), ctx);
   if (event.related) yield* self.call('Case.get', { id: event.related }, ctx);
   if (event.milestone) {
    const milestone = yield* self.call('CaseMilestone.get', { id: event.milestone }, ctx);
    yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: milestone.criteria }, ctx);
    const result = yield* new Evaluations(self.engine).result(String(milestone.evaluation), ctx);
    const approval = yield* new Decisions(self.engine).state(String(milestone.approval), ctx);
    if (String(result.finishedAt) > String(event.at) || approval.outcome?.selected !== milestone.accepted || String(approval.terminal?.createdAt) > String(event.at)) return yield* Effect.fail(err('ValidationFailed', 'Milestone requires completed evaluation and accepted decision before occurrence'));
    yield* self.support(milestone.support, ctx);
   }
  });
 }
 state(id: string, ctx: CallContext): Effect.Effect<CaseState, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('Case.get', { id }, ctx);
   yield* self.call('CaseSubject.get', { id: row.subject }, ctx);
   yield* self.engine.call('@forgegraph/foundation/specification/_/SpecificationPin.get', { id: row.context }, ctx);
   yield* self.engine.call('@forgegraph/foundation/party/_/Party.get', { id: row.owner }, ctx);
   yield* self.engine.call('@forgegraph/foundation/participation/_/ParticipationSet.get', { id: row.participants }, ctx);
   const resource = self.engine.model.resource(p + 'CaseEvent'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!;
   const storage = yield* Storage, events: Wire[] = [];
   for (let ordinal = 1; ordinal <= 128; ordinal++) {
    const values = { case: id, ordinal }, key = self.engine.claimKey(resource, unique, values)!;
    const found = yield* storage.findUnique(ctx.tenant, resource, unique, key, values);
    if (!found) break;
    const event = yield* self.call('CaseEvent.get', { id: found.id }, ctx);
    if ((event.previous ?? null) !== (events.at(-1)?.id ?? null)) return yield* Effect.fail(err('ValidationFailed', 'Case history is not consecutive'));
    yield* self.detail(event, ctx);
    events.push(event);
   }
   const head = events.at(-1);
   return { row, events, closed: head?.closed === true, owner: String(head?.owner ?? row.owner), head: head ? String(head.id) : null };
  }).pipe(Effect.provide(self.engine.layer));
 }
 act(input: { case: string; previous: string | null; kind: CaseAction; at: string; reason: string; fact?: string; owner?: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const state = yield* self.state(input.case, ctx);
   if (state.head !== input.previous) return yield* Effect.fail(err('VersionConflict', 'Case history changed'));
   if (state.closed !== (input.kind === 'reopen')) return yield* Effect.fail(err('InvalidTransition', 'Only a closed case can reopen; closed cases accept no other activity'));
   if (input.kind === 'transfer' && !input.owner) return yield* Effect.fail(err('ValidationFailed', 'Transfer requires a responsible party'));
   const field = ({ file: 'file', interaction: 'interaction', decision: 'decision', work: 'work', milestone: 'milestone', relate: 'related', escalate: 'related' } as Record<string, string>)[input.kind];
   if (!!field !== !!input.fact || (input.kind !== 'transfer' && input.owner != null)) return yield* Effect.fail(err('ValidationFailed', 'Unexpected or missing case event payload'));
   const at = yield* Effect.try({ try: () => decodeDatetime(input.at), catch: () => err('ValidationFailed', 'Invalid case event instant') });
   const event: Wire = { case: input.case, previous: input.previous, ordinal: state.events.length + 1, kind: input.kind, at, reason: input.reason, recordedBy: ctx.actor, closed: input.kind === 'close', owner: input.kind === 'transfer' ? input.owner : state.owner, file: null, interaction: null, decision: null, work: null, milestone: null, related: null, ...(field ? { [field]: input.fact } : {}) };
   yield* self.detail(event, ctx);
   return yield* self.call('CaseEvent.create', event, ctx);
  });
 }
}
