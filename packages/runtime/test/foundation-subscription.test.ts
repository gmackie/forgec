import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { foundation, foundationAdapters } from './helpers/foundation.js';
import { agreement } from './helpers/agreement.js';
import { Subscriptions } from '../src/foundation/subscription.js';
import { Evidence } from '../src/foundation/evidence.js';
const p = '@forgegraph/foundation/subscription/_/';
for (const adapter of foundationAdapters) it(`${adapter}: fixed and renewing terms, grace, suspension, plan change and timed cancellation`, async () => {
 const h = await foundation('subscription', adapter, true), run = Effect.runPromise;
 try {
  const { call, engine, ctx } = h, c = await agreement(h), service = new Subscriptions(engine), from = '2026-02-01T00:00:00Z', until = '2026-04-01T00:00:00Z';
  const issuance = (await run(c.catalog.state(String(c.contract.id), from, ctx))).issuance!, right = await call('@forgegraph/foundation/agreement-catalog/_/AgreementEntitlementLink.get', { id: issuance.right });
  const bundle = await call('@forgegraph/foundation/evidence/_/EvidenceBundle.create', { key: 'consent', label: 'Subscription consent' }), seal = await run(new Evidence(engine).seal(String(bundle.id), null, ctx));
  const dimension = await call('@forgegraph/foundation/usage/_/UsageDimension.create', { key: 'requests', unit: 'count' }), stream = await call('@forgegraph/foundation/usage/_/UsageStream.create', { label: 'Requests', dimension: dimension.id });
  const allowance = await call('@forgegraph/foundation/quota/_/Allowance.create', { key: 'included', grant: right.entitlement, scope: c.scope.id, policy: c.pin.id, dimension: dimension.id, unit: 'count', limit: '100', warningAt: '80', window: 'CalendarMonth', windowSeconds: null, timezone: 'UTC', validFrom: from, validUntil: '2026-12-01T00:00:00Z', measure: 'Usage', stream: stream.id, pool: null, enforcement: 'Hard', predecessor: null });
  const periods = new Map<string, string>();
  async function term(subscription: string, previous: string | null, start: string, end: string, consent = String(c.approval.id), accepted = String(c.accepted.id)) {
   const key = start + end;
   let billing = periods.get(key); if (!billing) { billing = String((await call('@forgegraph/foundation/billing/_/BillingPeriod.create', { agreement: c.contract.id, terms: c.pin.id, from: start, until: end })).id); periods.set(key, billing); }
   return call(p + 'SubscriptionTerm.create', { subscription, previous, agreement: c.contract.id, right: right.id, entitlement: right.entitlement, billing, allowance: allowance.id, serviceLevel: null, consent, accepted, from: start, until: end });
  }
  for (const mode of ['fixed', 'autoRenew', 'evergreen']) {
   const sub = await call(p + 'Subscription.create', { key: mode, customer: c.customer.id, policy: c.pin.id, mode, graceSeconds: 3600 });
   const first = await term(String(sub.id), null, from, until), base = { subscription: String(sub.id), term: String(first.id), reason: 'Policy', support: String(seal.id) };
   expect((await run(service.state(String(sub.id), from, ctx))).phase).toBe('pending');
   const started = await run(service.act({ ...base, previous: null, kind: 'start', effectiveAt: from }, ctx));
   expect((await run(service.state(String(sub.id), from, ctx))).effective).toBe(true);
   expect((await run(service.state(String(sub.id), from, ctx))).quota).not.toBeNull();
   const suspended = await run(service.act({ ...base, previous: String(started.id), kind: 'suspend', effectiveAt: '2026-03-01T00:00:00Z' }, ctx));
   expect((await run(service.state(String(sub.id), '2026-03-01T00:30:00Z', ctx))).phase).toBe('grace');
   expect((await run(service.state(String(sub.id), '2026-03-01T00:30:00Z', ctx))).effective).toBe(true);
   expect((await run(service.state(String(sub.id), '2026-03-01T01:00:00Z', ctx))).effective).toBe(false);
   await expect(run(service.act({ ...base, previous: String(started.id), kind: 'resume', effectiveAt: '2026-03-02T00:00:00Z' }, ctx))).rejects.toThrow();
   const resumed = await run(service.act({ ...base, previous: String(suspended.id), kind: 'resume', effectiveAt: '2026-03-02T00:00:00Z' }, ctx));
   const second = await term(String(sub.id), String(first.id), until, '2026-06-01T00:00:00Z');
   if (mode === 'fixed') {
    await expect(run(service.act({ ...base, term: String(second.id), previous: String(resumed.id), kind: 'renew', effectiveAt: until }, ctx))).rejects.toThrow();
    expect((await run(service.state(String(sub.id), until, ctx))).phase).toBe('expired');
   } else {
    const gap = await term(String(sub.id), String(first.id), '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
    await expect(run(service.act({ ...base, term: String(gap.id), previous: String(resumed.id), kind: 'renew', effectiveAt: '2026-05-01T00:00:00Z' }, ctx))).rejects.toThrow();
    const renewed = await run(service.act({ ...base, term: String(second.id), previous: String(resumed.id), kind: 'renew', effectiveAt: until }, ctx));
    const changed = await term(String(sub.id), String(second.id), '2026-05-01T00:00:00Z', '2026-07-01T00:00:00Z');
    const change = await run(service.act({ ...base, term: String(changed.id), previous: String(renewed.id), kind: 'change', effectiveAt: '2026-05-01T00:00:00Z' }, ctx));
    const cancelled = await run(service.act({ ...base, term: String(changed.id), previous: String(change.id), kind: 'cancel', effectiveAt: '2026-06-15T00:00:00Z' }, ctx));
    expect((await run(service.state(String(sub.id), '2026-06-14T00:00:00Z', ctx))).effective).toBe(true);
    expect((await run(service.state(String(sub.id), '2026-06-15T00:00:00Z', ctx))).phase).toBe('cancelled');
    await expect(run(service.act({ ...base, term: String(changed.id), previous: String(cancelled.id), kind: 'resume', effectiveAt: '2026-06-16T00:00:00Z' }, ctx))).rejects.toThrow();
   }
   for (const name of ['SaaSSubscription', 'MembershipSubscription', 'MediaSubscription', 'ServicePlanSubscription']) await call('@fixture/subscription-consumer/_/' + name + '.create', { subscription: sub.id, product: mode });
   await expect(run(service.state(String(sub.id), from, { ...ctx, tenant: 'foreign' }))).rejects.toThrow();
  }
  const pending = await run(c.decisions.open({ participationSet: String(c.participants.id), electors: [String(c.signers[1]!.id)], eligibilityAt: '2026-01-01T00:00:00Z', options: ['Accept', 'Reject'], rule: 'Single', deadline: '2027-01-01T00:00:00Z' }, ctx)), option = (await run(c.decisions.state(String(pending.id), ctx))).options[0]!;
  const sub = await call(p + 'Subscription.create', { key: 'unapproved', customer: c.customer.id, policy: c.pin.id, mode: 'autoRenew', graceSeconds: 0 }), unapproved = await term(String(sub.id), null, from, until, String(pending.id), String(option.id));
  await expect(run(service.act({ subscription: String(sub.id), previous: null, term: String(unapproved.id), kind: 'start', effectiveAt: from, reason: 'No consent', support: String(seal.id) }, ctx))).rejects.toThrow();
 } finally { await h.close(); }
});
