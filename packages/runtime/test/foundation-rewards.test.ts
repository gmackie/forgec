import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { agreement } from './helpers/agreement.js';
import { Rewards } from '../src/foundation/rewards.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Evaluations } from '../src/foundation/evaluation.js';
import { Ledger } from '../src/foundation/ledger.js';
import { Usage } from '../src/foundation/usage.js';
import { Fulfillments } from '../src/foundation/fulfillment.js';
const p = '@forgegraph/foundation/rewards/_/', l = '@forgegraph/foundation/ledger/_/', e = '@forgegraph/foundation/evaluation/_/', f = '@forgegraph/foundation/fulfillment/_/';
for (const adapter of foundationAdapters) it(`${adapter}: evidenced point and benefit awards, redemption, expiry, reversal and correction`, async () => {
 const h = await foundation('rewards', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, c = await agreement(h), service = new Rewards(engine), ledger = new Ledger(engine), at = '2026-01-02T00:00:00Z', endedAt = '2026-01-04T00:00:00Z';
  const offer = await run(c.catalog.offer(String(c.contract.offer), ctx)), entry = await call('@forgegraph/foundation/agreement-catalog/_/CatalogEntry.get', { id: offer.entry });
  const book = await call(l + 'LedgerBook.create', { key: 'points' }), funding = await call(l + 'Account.create', { book: book.id, key: 'program', unit: 'points' }), account = await call(l + 'Account.create', { book: book.id, key: 'customer', unit: 'points' });
  const program = await call(p + 'RewardProgram.create', { key: 'loyalty', specification: c.pin.id, eligibility: c.pin.id, earning: c.pin.id, catalog: entry.catalog, funding: funding.id, from: '2026-01-01T00:00:00Z', until: '2027-01-01T00:00:00Z' }), member = await call(p + 'RewardMember.create', { program: program.id, party: c.customer.id, account: account.id });
  const bundle = await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create', { key: 'award', label: 'Award evidence' }), seal = await run(new Evidence(engine).seal(String(bundle.id), null, ctx));
  const evalSet = await call(e + 'EvaluationSet.create', { label: 'Reward evaluations' }), executor = await call(e + 'EvaluationExecutor.create', { key: 'rules', label: 'Rules' }), evaluations = new Evaluations(engine), evaluation = await run(evaluations.create({ evaluationSet: String(evalSet.id), definition: String(c.pin.id), executor: String(executor.id) }, ctx));
  await run(evaluations.start(String(evaluation.id), '2026-01-01T00:00:00Z', ctx)); const finish = await run(evaluations.finish(String(evaluation.id), 'Completed', '2026-01-01T00:00:00Z', 'Eligible behavior', ctx));
  const dimension = await call('@forgegraph/foundation/usage/_/UsageDimension.create', { key: 'activity', unit: 'count' }), stream = await call('@forgegraph/foundation/usage/_/UsageStream.create', { label: 'Activity', dimension: dimension.id }), source = await call('@forgegraph/foundation/usage/_/UsageSource.create', { key: 'activity' });
  let ordinal = 0;
  async function claim(key: string) { const usage = await run(new Usage(engine).ingest({ stream: String(stream.id), dimension: String(dimension.id), unit: 'count', quantity: '1', ordinal: ++ordinal, source: String(source.id), eventKey: key, occurredAt: '2026-01-01T00:00:00Z' }, ctx)); return call(p + 'RewardClaim.create', { member: member.id, sourceKey: key, usage: usage.id, outcome: null }); }
  async function post(key: string, amount: string) { return run(ledger.post({ book: String(book.id), key, policy: 'balanced', reason: 'Rewards', entries: [{ account: String(account.id), quantity: amount }, { account: String(funding.id), quantity: amount.startsWith('-') ? amount.slice(1) : '-' + amount }] }, ctx)); }
  const common = { revision: 1, previous: null, eligibilityRun: evaluation.id, eligibility: finish.id, earningRun: evaluation.id, earning: finish.id, approval: c.approval.id, accepted: c.accepted.id, support: seal.id, at, expiresAt: '2026-02-01T00:00:00Z' };
  const firstClaim = await claim('purchase'), credit = await post('earn', '10'), award = await call(p + 'RewardAward.create', { ...common, claim: firstClaim.id, points: '10', posting: credit.id, benefit: null });
  expect((await run(service.state(String(award.id), at, ctx))).available).toBe(true);
  const badClaim = await claim('incorrect'), badCredit = await post('wrong', '2'), wrong = await call(p + 'RewardAward.create', { ...common, claim: badClaim.id, points: '10', posting: badCredit.id, benefit: null });
  await expect(run(service.state(String(wrong.id), at, ctx))).rejects.toThrow();
  const benefit = await call('@forgegraph/foundation/entitlement/_/Entitlement.create', { holder: c.customer.id, right: c.right.id, scope: c.scope.id, quantity: null, unit: null, validFrom: at, validUntil: '2026-02-01T00:00:00Z', predecessor: null, reason: 'Badge', recordedBy: ctx.actor }), badgeClaim = await claim('course'), badge = await call(p + 'RewardAward.create', { ...common, claim: badgeClaim.id, points: null, posting: null, benefit: benefit.id });
  expect((await run(service.state(String(badge.id), at, ctx))).available).toBe(true);
  const reversalClaim = await claim('referral'), reversalCredit = await post('referral', '5'), reversible = await call(p + 'RewardAward.create', { ...common, claim: reversalClaim.id, points: '5', posting: reversalCredit.id, benefit: null });
  engine.testClockJump(2 * 24 * 3600 * 1000);
  const set = await call(f + 'FulfillmentSet.create', { label: 'Redemption' }), worker = await call(f + 'FulfillmentExecutor.create', { key: 'rewards' }), work = await call(f + 'Fulfillment.create', { fulfillmentSet: set.id, ordinal: 1, specificationPin: c.pin.id, executor: worker.id, requestedAt: endedAt, evidence: null }), redemption = await call(p + 'RewardRedemption.create', { award: award.id, offer: offer.id, fulfillment: work.id }), debit = await post('redeem', '-10');
  const end = { award: String(award.id), kind: 'redeemed' as const, at: endedAt, reason: 'Redeemed', redemption: String(redemption.id), posting: String(debit.id) };
  await expect(run(service.end(end, ctx))).rejects.toThrow();
  await run(new Fulfillments(engine).start(String(work.id), endedAt, ctx)); await run(new Fulfillments(engine).finish(String(work.id), 'completed', 'complete', endedAt, 'Reward delivered', ctx));
  const race = await Promise.allSettled([run(service.end(end, ctx)), run(service.end(end, ctx))]);
  expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await run(service.state(String(award.id), endedAt, ctx))).available).toBe(false);
  const reverse = await run(ledger.reverse(String(book.id), String(reversalCredit.id), 'reverse-referral', 'Correction', ctx));
  await run(service.end({ award: String(reversible.id), kind: 'reversed', posting: String(reverse.id), at: endedAt, reason: 'Correction' }, ctx));
  const correctedCredit = await post('corrected', '4'), corrected = await call(p + 'RewardAward.create', { ...common, claim: reversalClaim.id, revision: 2, previous: reversible.id, points: '4', posting: correctedCredit.id, benefit: null, at: endedAt });
  expect((await run(service.state(String(corrected.id), endedAt, ctx))).available).toBe(true);
  const expired = await call('@forgegraph/foundation/entitlement/_/EntitlementEnd.create', { entitlement: benefit.id, kind: 'Expired', effectiveAt: '2026-02-01T00:00:00Z', recordedBy: ctx.actor, reason: 'Badge expired' });
  await run(service.end({ award: String(badge.id), kind: 'expired', at: '2026-02-01T00:00:00Z', reason: 'Expiry', benefitEnd: String(expired.id) }, ctx));
  expect((await run(service.state(String(badge.id), '2026-02-01T00:00:00Z', ctx))).available).toBe(false);
  for (const name of ['CustomerLoyalty', 'EmployeeIncentive', 'ReferralReward', 'EducationReward']) await call('@fixture/rewards-consumer/_/' + name + '.create', { award: name === 'EducationReward' ? badge.id : award.id, context: name });
  await expect(run(service.state(String(award.id), at, { ...ctx, tenant: 'foreign' }))).rejects.toThrow();
 } finally { await h.close(); }
});
