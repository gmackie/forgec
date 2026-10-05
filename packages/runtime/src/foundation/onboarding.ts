import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { Storage } from '../services.js';
import { decodeDatetime } from '../codecs.js';
import { err } from '../errors.js';
import { Cases } from './case-management.js';
import { Evidence } from './evidence.js';
import { Evaluations } from './evaluation.js';
import { Decisions } from './decision.js';
import { Qualifications } from './qualification.js';
import { PartyRelationships } from './party-relationship.js';
import { AccessGovernance } from './access-governance.js';
import { Delegations } from './delegation.js';
import { Fulfillments } from './fulfillment.js';
import { Records } from './records.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/onboarding/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
export class Onboarding {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(pkg: string, type: string, id: unknown, ctx: CallContext) { return this.engine.call('@forgegraph/foundation/' + pkg + '/_/' + type + '.get', { id }, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const seal = yield* self.read('evidence', 'EvidenceSeal', id, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx); });
 }
 private work(id: unknown, at: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const work = yield* new Fulfillments(self.engine).status(String(id), ctx); if (work.phase !== 'completed' || work.coverage !== 'complete' || String(work.end!.endedAt) > at) return yield* fail('Transition requires completed work before the gate'); return work; });
 }
 inspect(id: string, instant: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const at = yield* Effect.try({ try: () => decodeDatetime(instant), catch: () => err('ValidationFailed', 'Invalid transition instant') });
   const row = yield* self.call('Onboarding.get', { id }, ctx), activity = yield* new Cases(self.engine).state(String(row.case), ctx);
   yield* self.read('specification', 'SpecificationPin', row.criteria, ctx);
   const submission = yield* self.read('intake', 'Submission', row.submission, ctx), validation = yield* self.read('intake', 'SubmissionValidation', row.validation, ctx), evaluation = yield* new Evaluations(self.engine).result(String(validation.finish), ctx), decision = yield* new Decisions(self.engine).state(String(row.decision), ctx);
   if (submission.raw) yield* self.read('artifact', 'ArtifactRevision', submission.raw, ctx);
   if (String(submission.submittedAt) > String(evaluation.finishedAt) || decision.outcome?.selected !== row.accepted || String(decision.terminal?.createdAt) < String(evaluation.finishedAt) || String(decision.terminal?.createdAt) > at) return yield* fail('Accepted intake must precede the activation decision');
   if (!(yield* new Qualifications(self.engine).satisfies(String(row.subject), String(row.requirement), at, ctx)).qualified) return yield* fail('Subject is not qualified');
   const party = row.party ? yield* self.read('qualification', 'PartySubject', row.party, ctx) : null;
   if (party && submission.submitter !== party.party) return yield* fail('Intake does not belong to this party');
   if (row.principal) yield* self.read('delegation', 'DelegationSubject', row.principal, ctx);
   const gates: Wire[] = [], resource = self.engine.model.resource(p + 'OnboardingGate'), unique = resource.uniques.find(u => u.fields.includes('ordinal'))!, storage = yield* Storage;
   for (let ordinal = 1; ordinal <= Number(row.gateCount); ordinal++) {
    const values = { onboarding: id, ordinal }, found = yield* storage.findUnique(ctx.tenant, resource, unique, self.engine.claimKey(resource, unique, values)!, values);
    if (!found) return yield* fail('Onboarding gates are incomplete');
    const gate = yield* self.call('OnboardingGate.get', { id: found.id }, ctx);
    if ((gate.previous ?? null) !== (gates.at(-1)?.id ?? null) || String(gate.at) < String(decision.terminal!.createdAt) || String(gate.at) > at) return yield* fail('Gate order or approval chronology is invalid');
    if (gate.relationship) {
     const relation = yield* new PartyRelationships(self.engine).current(String(gate.relationship), at, ctx);
     if (!relation || party && relation.fromParty !== party.party && relation.toParty !== party.party) return yield* fail('Relationship must be active for this party');
    }
    if (gate.access) {
     const access = yield* new AccessGovernance(self.engine).explain(String(gate.access), at, ctx);
     if (!access.effective || access.identity.subject !== row.principal || access.identity.qualificationSubject !== row.subject) return yield* fail('Access is not effective for this subject');
    }
    if (gate.delegation) { const delegation = yield* new Delegations(self.engine).explain(String(gate.delegation), at, ctx); if (!delegation.effective || delegation.delegation.delegate !== row.principal) return yield* fail('Delegation is not effective for this principal'); }
    if (gate.configuration) { const config = yield* self.call('OnboardingConfiguration.get', { id: gate.configuration }, ctx), finish = yield* new Evaluations(self.engine).result(String(config.finish), ctx); yield* self.read('specification', 'SpecificationPin', config.definition, ctx); yield* self.support(config.support, ctx); if (String(finish.finishedAt) > String(gate.at)) return yield* fail('Configuration was not verified before gate'); }
    if (gate.provision) { const work = yield* self.work(gate.provision, String(gate.at), ctx); if (String(work.end!.endedAt) < String(decision.terminal!.createdAt)) return yield* fail('Provisioning predates approval'); }
    gates.push(gate);
   }
   if (!gates.some(g => g.relationship) || !gates.some(g => g.provision)) return yield* fail('Relationship and provisioning gates are required');
   return { row, activity, gates, head: String(gates.at(-1)!.id) };
  }).pipe(Effect.provide(self.engine.layer));
 }
 activate(input: { onboarding: string; at: string; support: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const state = yield* self.inspect(input.onboarding, input.at, ctx); yield* self.support(input.support, ctx); return yield* self.call('OnboardingActivation.create', { ...input, head: state.head }, ctx); });
 }
 activation(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const row = yield* self.call('OnboardingActivation.get', { id }, ctx), onboarding = yield* self.inspect(String(row.onboarding), String(row.at), ctx); yield* self.support(row.support, ctx); if (row.head !== onboarding.head) return yield* fail('Activation gate head differs'); return { row, onboarding }; });
 }
 completion(id: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const row = yield* self.call('OffboardingCompletion.get', { id }, ctx), offboarding = yield* self.call('Offboarding.get', { id: row.offboarding }, ctx), activation = yield* self.activation(String(offboarding.activation), ctx);
   if (String(row.at) <= String(activation.row.at)) return yield* fail('Offboarding must follow activation');
   yield* new Cases(self.engine).state(String(offboarding.case), ctx); yield* self.read('specification', 'SpecificationPin', offboarding.policy, ctx); yield* self.support(row.support, ctx);
   for (const field of ['cleanup', 'transfer']) { const work = yield* self.work(offboarding[field], String(row.at), ctx); if (String(work.end!.endedAt) < String(activation.row.at)) return yield* fail('Cleanup and transfer must follow activation'); }
   const obligations = yield* new Evaluations(self.engine).result(String(row.obligations), ctx), approval = yield* new Decisions(self.engine).state(String(offboarding.approval), ctx);
   if (String(obligations.finishedAt) < String(activation.row.at) || approval.outcome?.selected !== offboarding.accepted || String(approval.terminal?.createdAt) < String(obligations.finishedAt) || String(approval.terminal?.createdAt) > String(row.at)) return yield* fail('Obligation review requires a subsequent accepted decision');
   const retention = yield* new Records(self.engine).state(String(offboarding.retention), ctx);
   if (String(retention.record.triggeredAt) < String(activation.row.at) || String(retention.record.triggeredAt) > String(row.at)) return yield* fail('Retention trigger must belong to the offboarding interval');
   for (const gate of activation.onboarding.gates) {
    for (const [field, pkg, type, key] of [['relationship', 'party-relationship', 'PartyRelationshipEnd', 'relationship'], ['access', 'access-governance', 'AccessGrantEnd', 'grant'], ['delegation', 'delegation', 'DelegationRevocation', 'delegation']] as const) {
     if (!gate[field]) continue;
     const end = yield* findTerminalFact(self.engine, '@forgegraph/foundation/' + pkg + '/_/' + type, key, gate[field], ctx);
     if (!end || String(end.effectiveAt) <= String(activation.row.at) || String(end.effectiveAt) > String(row.at) || end.replacement != null) return yield* fail('Every linked relationship and authority requires an explicit terminal end');
    }
   }
   return { row, offboarding, activation, retention };
  });
 }
}
