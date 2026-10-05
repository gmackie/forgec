import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { agreement } from './helpers/agreement.js';
import { Disputes } from '../src/foundation/dispute-appeal.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Evaluations } from '../src/foundation/evaluation.js';
import { Fulfillments } from '../src/foundation/fulfillment.js';
const p = '@forgegraph/foundation/dispute-appeal/_/', c = '@forgegraph/foundation/case-management/_/', e = '@forgegraph/foundation/evaluation/_/', f = '@forgegraph/foundation/fulfillment/_/';
for (const adapter of foundationAdapters) it(`${adapter}: immutable contested decision, mandated review, remedies and recursive appeals`, async () => {
 const h = await foundation('dispute-appeal', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, contract = await agreement(h), service = new Disputes(engine), filedAt = '2026-01-01T01:00:00Z', reviewedAt = '2026-01-01T01:00:01Z', at = '2026-01-02T00:00:00Z';
  engine.testClockJump(2 * 3600 * 1000);
  const original = (await run(contract.decisions.state(String(contract.approval.id), ctx))).outcome!;
  const contested = await call(p + 'ContestedFact.create', { decision: original.id, charge: null, finding: null, outcome: null });
  const bundle = await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create', { key: 'grounds', label: 'Grounds' }), seal = await run(new Evidence(engine).seal(String(bundle.id), null, ctx));
  const subject = await call(c + 'CaseSubject.create', { key: 'appeal' }), set = await call(e + 'EvaluationSet.create', { label: 'Reviews' }), executor = await call(e + 'EvaluationExecutor.create', { key: 'reviewer', label: 'Reviewer' }), evaluations = new Evaluations(engine);
  const mandate = await call(p + 'ReviewMandate.create', { authority: contract.supplier.id, reviewer: contract.signers[0]!.id, jurisdiction: contract.pin.id, policy: contract.pin.id, support: seal.id, from: filedAt, until: '2027-02-01T00:00:00Z' });
  async function review(key: string, level: number, previous: string | null, priorResult: string | null, filed: string, verdict: 'uphold' | 'modify' | 'reverse' | 'remand') {
   const activity = await call(c + 'Case.create', { key, subject: subject.id, context: contract.pin.id, reason: 'Challenge original', owner: contract.supplier.id, participants: contract.participants.id, openedAt: filed });
   const evaluation = await run(evaluations.create({ evaluationSet: String(set.id), definition: String(contract.pin.id), executor: String(executor.id) }, ctx));
   const decision = await run(contract.decisions.open({ participationSet: String(contract.participants.id), electors: [String(contract.signers[0]!.id)], eligibilityAt: filed, options: ['uphold', 'modify', 'reverse', 'remand'], rule: 'Single', deadline: '2027-01-01T00:00:00Z' }, ctx)), options = (await run(contract.decisions.state(String(decision.id), ctx))).options;
   const body = { key, case: activity.id, contested: contested.id, appellant: contract.customer.id, grounds: 'Original omitted evidence', requestedRemedy: contract.pin.id, support: seal.id, jurisdiction: contract.pin.id, policy: contract.pin.id, authority: contract.supplier.id, reviewer: contract.signers[0]!.id, mandate: mandate.id, filedAt: filed, filingDeadline: '2026-12-01T00:00:00Z', reviewDeadline: '2027-01-01T00:00:00Z', evaluation: evaluation.id, decision: decision.id, uphold: options[0]!.id, modify: options[1]!.id, reverse: options[2]!.id, remand: options[3]!.id, previous, priorResult, level };
   const dispute = await call(p + 'Dispute.create', body);
   await run(service.inspect(String(dispute.id), ctx));
   await run(evaluations.start(String(evaluation.id), filed, ctx));
   const finish = await run(evaluations.finish(String(evaluation.id), 'Completed', level === 1 ? reviewedAt : filed, 'Reviewed', ctx));
   await run(contract.decisions.respond(String(decision.id), String(contract.signers[0]!.id), [options.findIndex(o => o.label === verdict)], ctx));
   await run(contract.decisions.finalize(String(decision.id), ctx));
   const outcome = (await run(contract.decisions.state(String(decision.id), ctx))).outcome!;
   const result = await call(p + 'DisputeResult.create', { dispute: dispute.id, review: finish.id, decision: outcome.id, verdict, rationale: 'New evidence considered', support: seal.id, at: level === 1 ? at : '2026-01-05T00:00:00Z' });
   expect((await run(service.result(String(result.id), ctx))).row.verdict).toBe(verdict);
   return { dispute, result, body };
  }
  const first = await review('first', 1, null, null, filedAt, 'reverse');
  const workSet = await call(f + 'FulfillmentSet.create', { label: 'Remedy' }), worker = await call(f + 'FulfillmentExecutor.create', { key: 'remedy' }), work = await call(f + 'Fulfillment.create', { fulfillmentSet: workSet.id, ordinal: 1, specificationPin: contract.pin.id, executor: worker.id, requestedAt: at, evidence: null });
  const remedy = await call(p + 'DisputeRemedy.create', { result: first.result.id, implementation: contract.pin.id, fulfillment: work.id, adjustment: null, change: null, support: seal.id, at });
  await expect(run(service.remedy(String(remedy.id), ctx))).rejects.toThrow();
  await run(new Fulfillments(engine).start(String(work.id), at, ctx)); await run(new Fulfillments(engine).finish(String(work.id), 'completed', 'complete', at, 'Reversed effect', ctx));
  expect((await run(service.remedy(String(remedy.id), ctx))).result.row.verdict).toBe('reverse');
  await review('modify', 1, null, null, filedAt, 'modify');
  await review('remand', 1, null, null, filedAt, 'remand');
  engine.testClockJump(3 * 24 * 3600 * 1000);
  const second = await review('appeal', 2, String(first.dispute.id), String(first.result.id), at, 'uphold');
  expect((await run(service.inspect(String(second.dispute.id), ctx))).row.level).toBe(2);
  expect((await run(contract.decisions.state(String(contract.approval.id), ctx))).outcome!.id).toBe(original.id);
  await expect(call(p + 'DisputeRemedy.create', { result: second.result.id, implementation: contract.pin.id, fulfillment: work.id, adjustment: null, change: null, support: seal.id, at: '2026-01-05T00:00:00Z' })).rejects.toThrow();
  for (const name of ['BillingDispute', 'BenefitsAppeal', 'ModerationAppeal', 'QualityAppeal']) await call('@fixture/dispute-appeal-consumer/_/' + name + '.create', { dispute: first.dispute.id, context: name });
  await call(p + 'ReviewMandateEnd.create', { mandate: mandate.id, at: filedAt, reason: 'Invalidated' });
  await expect(run(service.result(String(first.result.id), ctx))).rejects.toThrow();
  await expect(run(service.inspect(String(first.dispute.id), { ...ctx, tenant: 'foreign' }))).rejects.toThrow();
  await expect(call(p + 'Dispute.create', { ...first.body, key: 'late', filedAt: '2027-01-02T00:00:00Z' })).rejects.toThrow();
 } finally { await h.close(); }
});
