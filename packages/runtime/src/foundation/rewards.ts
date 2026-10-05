import { Effect } from 'effect';
import type { Engine, CallContext } from '../engine.js';
import type { Wire } from '../decode.js';
import { decodeDatetime, toMinor } from '../codecs.js';
import { err, type ForgeError } from '../errors.js';
import { Evaluations } from './evaluation.js';
import { Decisions } from './decision.js';
import { Evidence } from './evidence.js';
import { Ledger } from './ledger.js';
import { Fulfillments } from './fulfillment.js';
import { AgreementCatalog } from './agreement-catalog.js';
import { findTerminalFact } from './facts.js';
const p = '@forgegraph/foundation/rewards/_/';
const fail = (message: string) => Effect.fail(err('ValidationFailed', message));
export class Rewards {
 constructor(private readonly engine: Engine) {}
 private call(op: string, input: Wire, ctx: CallContext) { return this.engine.call(p + op, input, ctx); }
 private read(pkg: string, type: string, id: unknown, ctx: CallContext) { return this.engine.call('@forgegraph/foundation/' + pkg + '/_/' + type + '.get', { id }, ctx); }
 private support(id: unknown, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () { const seal = yield* self.read('evidence', 'EvidenceSeal', id, ctx); yield* new Evidence(self.engine).sealedItems(String(seal.bundle), ctx); });
 }
 private transfer(posting: unknown, member: Wire, program: Wire, amount: bigint, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const group = yield* new Ledger(self.engine).inspect(String(posting), ctx), funding = yield* self.read('ledger', 'Account', program.funding, ctx), account = yield* self.read('ledger', 'Account', member.account, ctx);
   if (account.book !== funding.book || account.unit !== funding.unit || group.fact.book !== funding.book || group.fact.policy !== 'balanced') return yield* fail('Reward points must use the program book and unit');
   const totals = new Map<string, bigint>();
   for (const entry of group.entries) totals.set(entry.account, (totals.get(entry.account) ?? 0n) + toMinor(entry.quantity, 6));
   if (totals.size !== 2 || totals.get(String(member.account)) !== amount || totals.get(String(program.funding)) !== -amount) return yield* fail('Posting must exactly transfer the award between member and program');
   return group;
  });
 }
 private award(id: string, ctx: CallContext, depth = 0): Effect.Effect<{ row: Wire; member: Wire; program: Wire; reversed: boolean }, ForgeError> {
  const self = this;
  return Effect.gen(function* () {
   if (depth >= 8) return yield* fail('Award correction depth exceeds eight');
   const row = yield* self.call('RewardAward.get', { id }, ctx), claim = yield* self.call('RewardClaim.get', { id: row.claim }, ctx), member = yield* self.call('RewardMember.get', { id: claim.member }, ctx), program = yield* self.call('RewardProgram.get', { id: member.program }, ctx);
   yield* self.read('party', 'Party', member.party, ctx); yield* self.read('agreement-catalog', 'Catalog', program.catalog, ctx);
   for (const field of ['specification', 'eligibility', 'earning']) yield* self.read('specification', 'SpecificationPin', program[field], ctx);
   if (String(row.at) < String(program.from) || String(row.at) >= String(program.until)) return yield* fail('Award is outside the program window');
   let observed: string;
   if (claim.usage) {
    const usage = yield* self.read('usage', 'UsageEvent', claim.usage, ctx);
    yield* self.read('usage', 'UsageSource', usage.source, ctx); yield* self.read('usage', 'UsageStream', usage.stream, ctx);
    // Awards retain the immutable behavior snapshot; later Usage corrections require explicit award reversal.
    if (usage.replacementFor) { const admitted = yield* findTerminalFact(self.engine, '@forgegraph/foundation/usage/_/UsageCorrection', 'event', usage.replacementFor, ctx); if (admitted?.replacement !== usage.id) return yield* fail('Usage replacement is not admitted'); }
    observed = String(usage.occurredAt ?? usage.intervalEnd);
   } else { const end = yield* self.read('fulfillment', 'FulfillmentEnd', claim.outcome, ctx), work = yield* new Fulfillments(self.engine).status(String(end.fulfillment), ctx); if (work.end?.id !== end.id || work.phase !== 'completed') return yield* fail('Reward outcome is not completed'); observed = String(end.endedAt); }
   let finished = observed;
   for (const field of ['eligibility', 'earning']) {
    const finish = yield* new Evaluations(self.engine).result(String(row[field]), ctx), run = yield* self.read('evaluation', 'EvaluationRun', finish.run, ctx);
    if (run.definition !== program[field] || String(finish.finishedAt) < observed) return yield* fail('Evaluation does not apply the pinned program rule after behavior');
    if (String(finish.finishedAt) > finished) finished = String(finish.finishedAt);
   }
   const decision = yield* new Decisions(self.engine).state(String(row.approval), ctx);
   if (decision.outcome?.selected !== row.accepted || String(decision.terminal?.createdAt) < finished || String(decision.terminal?.createdAt) > String(row.at)) return yield* fail('Award requires accepted evaluation before award time');
   yield* self.support(row.support, ctx);
   let reversed = false;
   if (row.posting) { const posting = yield* self.transfer(row.posting, member, program, toMinor(String(row.points), 6), ctx); if (posting.fact.reversalOf != null || String(posting.fact.createdAt) > String(row.at)) return yield* fail('Award must reference an original published credit'); reversed = posting.reversedBy != null; }
   else { const benefit = yield* self.read('entitlement', 'Entitlement', row.benefit, ctx); if (benefit.holder !== member.party || benefit.quantity != null || String(benefit.validFrom) > String(row.at) || benefit.validUntil != null && String(benefit.validUntil) < String(row.expiresAt)) return yield* fail('Nonfungible benefit must belong to member and cover award lifetime'); }
   if (row.previous) { const prior = yield* self.award(String(row.previous), ctx, depth + 1), end = yield* findTerminalFact(self.engine, p + 'RewardEnd', 'award', row.previous, ctx); if (!end || end.kind !== 'reversed' || String(end.at) > String(row.at)) return yield* fail('Correction requires prior award reversal'); yield* self.terminal(end, prior, ctx); }
   return { row, member, program, reversed };
  });
 }
 private terminal(end: Wire, award: { row: Wire; member: Wire; program: Wire; reversed: boolean }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   if (award.reversed && end.kind !== 'reversed') return yield* fail('Reversed award cannot be redeemed or expired');
   if (award.row.posting) {
    const posting = yield* self.transfer(end.posting, award.member, award.program, -toMinor(String(award.row.points), 6), ctx);
    if (posting.reversedBy || String(posting.fact.createdAt) > String(end.at) || String(posting.fact.createdAt) < String(award.row.at) || (end.kind === 'reversed' ? posting.fact.reversalOf !== award.row.posting : posting.fact.reversalOf != null)) return yield* fail('Invalid terminal reward debit or reversal');
   } else { const revoked = yield* self.read('entitlement', 'EntitlementEnd', end.benefitEnd, ctx); if (String(revoked.effectiveAt) > String(end.at)) return yield* fail('Benefit has not ended'); }
   if (end.redemption) {
    const redemption = yield* self.call('RewardRedemption.get', { id: end.redemption }, ctx), offer = yield* new AgreementCatalog(self.engine).offer(String(redemption.offer), ctx), entry = yield* self.read('agreement-catalog', 'CatalogEntry', offer.entry, ctx), work = yield* new Fulfillments(self.engine).status(String(redemption.fulfillment), ctx);
    if (entry.catalog !== award.program.catalog || String(offer.validFrom) > String(end.at) || String(offer.validUntil) <= String(end.at) || work.phase !== 'completed' || work.coverage !== 'complete' || String(work.end!.endedAt) < String(award.row.at) || String(work.end!.endedAt) > String(end.at)) return yield* fail('Redemption needs catalog offer and complete separate fulfillment');
   }
  });
 }
 state(id: string, instant: string, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const at = yield* Effect.try({ try: () => decodeDatetime(instant), catch: () => err('ValidationFailed', 'Invalid reward instant') }), award = yield* self.award(id, ctx), end = yield* findTerminalFact(self.engine, p + 'RewardEnd', 'award', id, ctx);
   if (end) yield* self.terminal(end, award, ctx);
   const benefitEnd = award.row.benefit ? yield* findTerminalFact(self.engine, '@forgegraph/foundation/entitlement/_/EntitlementEnd', 'entitlement', award.row.benefit, ctx) : null;
   return { ...award, end, available: at >= String(award.row.at) && at < String(award.row.expiresAt) && !award.reversed && !(end && String(end.at) <= at) && !(benefitEnd && String(benefitEnd.effectiveAt) <= at) };
  });
 }
 end(input: { award: string; kind: 'redeemed' | 'expired' | 'reversed'; at: string; reason: string; redemption?: string; posting?: string; benefitEnd?: string }, ctx: CallContext) {
  const self = this;
  return Effect.gen(function* () {
   const award = yield* self.award(input.award, ctx), end = { ...input, redemption: input.redemption ?? null, posting: input.posting ?? null, benefitEnd: input.benefitEnd ?? null };
   yield* self.terminal(end, award, ctx);
   return yield* self.call('RewardEnd.create', end, ctx);
  });
 }
}
