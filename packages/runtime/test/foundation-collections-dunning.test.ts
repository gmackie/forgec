import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { agreement } from './helpers/agreement.js';
import { Collections } from '../src/foundation/collections-dunning.js';
import { Settlements, type SettlementAdmission } from '../src/foundation/settlement.js';
import { Cases } from '../src/foundation/case-management.js';
import { Fulfillments } from '../src/foundation/fulfillment.js';
import { Evidence } from '../src/foundation/evidence.js';
import { Notifications } from '../src/foundation/notifications.js';
import { Evaluations } from '../src/foundation/evaluation.js';
import { findTerminalFact } from '../src/foundation/facts.js';
import { err } from '../src/errors.js';
const p = '@forgegraph/foundation/collections-dunning/_/', s = '@forgegraph/foundation/settlement/_/', f = '@forgegraph/foundation/fulfillment/_/', c = '@forgegraph/foundation/case-management/_/', consumer = '@fixture/collections-dunning-consumer/_/';
for (const adapter of foundationAdapters) it(`${adapter}: delinquency aging, notices, promises, partial settlement, cure and reversal`, async () => {
 const h = await foundation('collections-dunning', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, contract = await agreement(h), earnedAt = '2026-02-01T00:00:00Z', openedAt = '2026-02-02T00:00:00Z', paidAt = '2026-02-03T00:00:00Z', finalAt = '2026-02-04T00:00:00Z', closedAt = '2026-02-05T00:00:00Z';
  const admission: SettlementAdmission = (source, positions, context, _effectiveAt, knownAt) => Effect.gen(function* () {
   const occurrence = yield* findTerminalFact(engine, consumer + 'EconomicOccurrence', 'fulfillmentEnd', source.fulfillmentEnd, context);
   if (!occurrence || knownAt && String(occurrence.createdAt) > knownAt || ['kind', 'unit', 'quantity', 'occurredAt'].some(field => source[field] !== occurrence[field])) return yield* Effect.fail(err('ValidationFailed', 'Source differs from typed observed occurrence'));
   for (const { position } of positions) if (position.creditor !== occurrence.creditor || position.debtor !== occurrence.debtor) return yield* Effect.fail(err('ValidationFailed', 'Wrong counterparties'));
  });
  const settlements = new Settlements(engine, admission), service = new Collections(engine, admission), cases = new Cases(engine);
  engine.testClockJump(32 * 24 * 3600 * 1000);
  const book = await call(s + 'SettlementBook.create', { key: 'receivables' }), obligation = await call('@forgegraph/foundation/entitlement/_/Obligation.create', { obligatedParty: contract.customer.id, requirement: contract.requirement.id, scope: contract.scope.id, quantity: '100', unit: 'USD', incurredAt: earnedAt, dueAt: openedAt, reason: 'Invoice', recordedBy: ctx.actor }), position = await run(settlements.openPosition({ book: String(book.id), obligation: String(obligation.id), creditor: String(contract.supplier.id), reason: 'Invoice' }, ctx));
  const set = await call(f + 'FulfillmentSet.create', { label: 'Financial observations' }), executor = await call(f + 'FulfillmentExecutor.create', { key: 'observer' }); let ordinal = 0;
  async function work(at: string) { const work = await call(f + 'Fulfillment.create', { fulfillmentSet: set.id, ordinal: ++ordinal, specificationPin: contract.pin.id, executor: executor.id, requestedAt: at, evidence: null }); const api = new Fulfillments(engine); await run(api.start(String(work.id), at, ctx)); const end = await run(api.finish(String(work.id), 'completed', 'complete', at, 'Observed', ctx)); return { work, end }; }
  async function economic(kind: 'Materialize' | 'Settle', quantity: string, at: string) {
   const observed = await work(at); await call(consumer + 'EconomicOccurrence.create', { fulfillmentEnd: observed.end.id, kind, creditor: contract.supplier.id, debtor: contract.customer.id, scope: contract.scope.id, unit: 'USD', quantity, occurredAt: at });
   const source = await run(settlements.admitSource({ book: String(book.id), key: 'source-' + ordinal, kind, unit: 'USD', quantity, occurredAt: at, fulfillmentEnd: String(observed.end.id), reason: 'Observed' }, ctx));
   const input = { book: String(book.id), key: 'event-' + ordinal, source: String(source.id), occurredAt: at, effectiveAt: at, reason: kind, lines: [{ position: String(position.id), quantity }] };
   return run(kind === 'Materialize' ? settlements.materialize(input, ctx) : settlements.settle(input, ctx));
  }
  const subject = await call(c + 'CaseSubject.create', { key: 'invoice' }), activity = await call(c + 'Case.create', { key: 'collection', subject: subject.id, context: contract.pin.id, reason: 'Overdue', owner: contract.supplier.id, participants: contract.participants.id, openedAt }), policy = await call(p + 'CollectionPolicy.create', { key: 'dunning', definition: contract.pin.id, warningDays: 7, escalationDays: 30 });
  await economic('Materialize', '100', earnedAt);
  const collection = await call(p + 'Collection.create', { key: 'invoice', case: activity.id, position: position.id, policy: policy.id, openedAt });
  expect((await run(service.state(String(collection.id), openedAt, ctx))).stage).toBe('overdue');
  expect((await run(service.state(String(collection.id), '2026-02-10T00:00:00Z', ctx))).stage).toBe('warning');
  expect((await run(service.state(String(collection.id), '2026-03-10T00:00:00Z', ctx))).stage).toBe('escalate');
  const n = '@forgegraph/foundation/notifications/_/', topic = await call(n + 'NotificationTopic.create', { key: 'statements', label: 'Statements' }), destination = await call('@forgegraph/foundation/delivery/_/DeliveryDestination.create', { key: 'debtor', label: 'Debtor mailbox' }), endpoint = await call(n + 'NotificationEndpointLink.create', { recipient: contract.signers[1]!.id, destination: destination.id }), subscription = await call(n + 'NotificationSubscription.create', { topic: topic.id, recipient: contract.signers[1]!.id, endpoint: endpoint.id }), preference = await call(n + 'NotificationPreference.create', { subscription: subscription.id, revision: 1, previous: null, enabled: true, reason: 'Statements' }), notice = await run(new Notifications(engine).create({ key: 'reminder', subscription: String(subscription.id), preference: String(preference.id), at: openedAt }, ctx)), linked = await call(p + 'CollectionNotice.create', { collection: collection.id, notification: notice.id, interaction: null });
  expect((await run(service.notice(String(linked.id), ctx))).outcome.status).toBe('Pending');
  const bundle = await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create', { key: 'promise', label: 'Promise' }), seal = await run(new Evidence(engine).seal(String(bundle.id), null, ctx));
  const promise = await call(p + 'PaymentPromise.create', { collection: collection.id, arrangement: contract.contract.id, approval: contract.approval.id, accepted: contract.accepted.id, amount: '100', unit: 'USD', at: openedAt, dueAt: finalAt, challenge: null, subject: null, partySubject: null, support: seal.id });
  expect((await run(service.promise(String(promise.id), openedAt, ctx))).status).toBe('pending');
  engine.testClockJump(3 * 24 * 3600 * 1000);
  await economic('Settle', '30', paidAt);
  expect((await run(service.promise(String(promise.id), finalAt, ctx))).status).toBe('broken');
  const premature = await run(cases.act({ case: String(activity.id), previous: null, kind: 'close', at: paidAt, reason: 'Premature' }, ctx)), invalidClosure = await call(p + 'CollectionClosure.create', { collection: collection.id, closure: premature.id, kind: 'cured', disposition: null });
  await expect(run(service.closure(String(invalidClosure.id), finalAt, ctx))).rejects.toThrow();
  const reopened = await run(cases.act({ case: String(activity.id), previous: String(premature.id), kind: 'reopen', at: paidAt, reason: 'Still due' }, ctx));
  const paid = await economic('Settle', '70', finalAt);
  expect((await run(service.promise(String(promise.id), finalAt, ctx))).status).toBe('kept');
  const closure = await run(cases.act({ case: String(activity.id), previous: String(reopened.id), kind: 'close', at: closedAt, reason: 'Paid' }, ctx)), cured = await call(p + 'CollectionClosure.create', { collection: collection.id, closure: closure.id, kind: 'cured', disposition: null });
  expect((await run(service.closure(String(cured.id), closedAt, ctx))).effective).toBe(true);
  engine.testClockJump(24 * 3600 * 1000);
  await run(settlements.reverse(String(book.id), String(paid.id), { key: 'reversal', occurredAt: closedAt, effectiveAt: '2026-02-06T00:00:00Z', reason: 'Payment reversed' }, ctx));
  expect((await run(service.closure(String(cured.id), '2026-02-06T00:00:00Z', ctx))).effective).toBe(false);
  expect((await run(service.promise(String(promise.id), '2026-02-06T00:00:00Z', ctx))).status).toBe('broken');
  const re = await run(cases.act({ case: String(activity.id), previous: String(closure.id), kind: 'reopen', at: '2026-02-06T00:00:00Z', reason: 'Reversed payment' }, ctx));
  expect(re.closed).toBe(false);
  const e = '@forgegraph/foundation/evaluation/_/', evalSet = await call(e + 'EvaluationSet.create', { label: 'Recovery assessment' }), evaluator = await call(e + 'EvaluationExecutor.create', { key: 'collector', label: 'Collector' }), evaluations = new Evaluations(engine), evaluation = await run(evaluations.create({ evaluationSet: String(evalSet.id), definition: String(contract.pin.id), executor: String(evaluator.id) }, ctx));
  await run(evaluations.start(String(evaluation.id), openedAt, ctx)); const finish = await run(evaluations.finish(String(evaluation.id), 'Completed', closedAt, 'Recovery warranted', ctx));
  const approval = await run(contract.decisions.open({ participationSet: String(contract.participants.id), electors: [String(contract.signers[0]!.id)], eligibilityAt: openedAt, options: ['Accept', 'Reject'], rule: 'Single', deadline: '2027-01-01T00:00:00Z' }, ctx)), option = (await run(contract.decisions.state(String(approval.id), ctx))).options[0]!;
  await run(contract.decisions.respond(String(approval.id), String(contract.signers[0]!.id), [0], ctx)); await run(contract.decisions.finalize(String(approval.id), ctx));
  const recovery = await work(closedAt), disposition = await call(p + 'CollectionDisposition.create', { collection: collection.id, kind: 'externalRecovery', policy: contract.pin.id, evaluation: finish.id, run: evaluation.id, approval: approval.id, accepted: option.id, posting: null, recovery: recovery.work.id, at: '2026-02-07T00:00:00Z', support: seal.id });
  await expect(run(service.disposition(String(disposition.id), ctx))).rejects.toThrow();
  const profile = new Collections(engine, admission, (row, position) => row.recovery === recovery.work.id && position.debtor === contract.customer.id ? Effect.void : Effect.fail(err('ValidationFailed', 'Unrelated recovery')));
  expect((await run(profile.disposition(String(disposition.id), ctx))).state.position.remaining).toBe('70.000000');
  const handedOff = await run(cases.act({ case: String(activity.id), previous: String(re.id), kind: 'close', at: '2026-02-07T00:00:00Z', reason: 'External recovery handoff' }, ctx)), recoveryClosure = await call(p + 'CollectionClosure.create', { collection: collection.id, closure: handedOff.id, kind: 'externalRecovery', disposition: disposition.id });
  expect((await run(profile.closure(String(recoveryClosure.id), '2026-02-07T00:00:00Z', ctx))).effective).toBe(true);

  for (const name of ['B2BCollections', 'SaaSCollections', 'ConsumerCollections']) await call(consumer + name + '.create', { collection: collection.id, account: name });
  await expect(run(service.state(String(collection.id), openedAt, { ...ctx, tenant: 'foreign' }))).rejects.toThrow();
  await expect(run(new Collections(engine, () => Effect.fail(err('ValidationFailed', 'Untrusted source'))).state(String(collection.id), openedAt, ctx))).rejects.toThrow();
 } finally { await h.close(); }
});
