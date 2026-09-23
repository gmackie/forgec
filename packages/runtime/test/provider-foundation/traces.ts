import { Effect } from 'effect';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { providerEnvironment } from './environment.js';
import { Allocations } from '../../src/foundation/allocation.js';
import { Ledger } from '../../src/foundation/ledger.js';
import { Usage } from '../../src/foundation/usage.js';
import { Engine } from '../../src/engine.js';
import { localAuthorizer } from '../../src/gatekeeper.js';
const a = '@forgegraph/foundation/allocation/_/', l = '@forgegraph/foundation/ledger/_/', u = '@forgegraph/foundation/usage/_/', p = '@foundation-provider/probe/_/';
const run = Effect.runPromise;
let f: Awaited<ReturnType<typeof providerEnvironment>>;
beforeAll(async () => { f = await providerEnvironment(); });
afterAll(async () => { if (f) await f.close(); });
const context = (name: string) => ({ tenant: f.tenantPrefix + '-' + name, actor: 'provider-certification', requestId: name });
it('capacity-race-and-restart', async () => {
  const ctx = context('capacity'), api = new Allocations(f.engine);
  const call = (name: string, body: Record<string, unknown>) => run(f.engine.call(a + name, body, ctx));
  const pool = await call('AllocationPool.create', { key: 'machine', mode: 'exclusive', capacity: '1', unit: 'slot' });
  const reservations = [];
  for (const key of ['one', 'two']) reservations.push(await call('AllocationReservation.create', { pool: pool.id, key, quantity: '1', unit: 'slot', from: '2026-01-02T00:00:00Z', until: '2026-01-03T00:00:00Z', holdUntil: '2026-01-01T12:00:00Z' }));
  const outcomes = await Promise.allSettled(reservations.map(reservation => run(api.act(String(reservation.id), 'book', ctx))));
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(r => r.status === 'rejected')).toHaveLength(1);
  const winner = reservations[outcomes.findIndex(r => r.status === 'fulfilled')]!;
  expect((await run(api.inspect(String(pool.id), '2026-01-02T12:00:00Z', ctx))).available).toBe('0.000000');
  const restarted = new Allocations(new Engine(f.model, f.engine.layer));
  await run(restarted.act(String(winner.id), 'release', ctx));
  await run(restarted.act(String(winner.id), 'release', ctx));
  expect((await run(api.inspect(String(pool.id), '2026-01-02T12:00:00Z', ctx))).available).toBe('1.000000');
  const journal = await call('AllocationJournal.list.byPool', { params: { pool: pool.id } });
  expect((journal.items as { action: string }[]).filter(e => e.action === 'release')).toHaveLength(1);
});
it('authorized-atomic-rollback', async () => {
  const ctx = context('atomic'), call = (name: string, body: Record<string, unknown>) => run(f.engine.call(p + name, body, ctx));
  await call('Publication.create', { key: 'occupied' });
  await expect(run(f.engine.atomic([{ operation: p + 'Publication.create', input: { key: 'must-not-leak' } }, { operation: p + 'Publication.create', input: { key: 'occupied' } }], ctx))).rejects.toThrow();
  // If the first write leaked, this retry cannot create its unique identity.
  const fresh = await call('Publication.create', { key: 'must-not-leak' }); expect(fresh.id).toBeTruthy();
  const guarded = new Engine(f.model, f.engine.layer);
  guarded.gatekeeper.authorizer = localAuthorizer({ policies: [{ id: 'reads', actions: [p + 'Publication.get'], requires: [], where: [] }], pips: [], epoch: 1, knownObligations: [] });
  await expect(run(guarded.atomic([{ operation: p + 'Publication.create', input: { key: 'denied' } }], ctx))).rejects.toThrow();
  expect((await call('Publication.create', { key: 'denied' })).id).toBeTruthy();
  await expect(run(f.engine.call(p + 'Publication.get', { id: fresh.id }, { ...ctx, tenant: ctx.tenant + '-foreign' }))).rejects.toThrow();
});
it('exact-ledger-reversal', async () => {
  const ctx = context('ledger'), api = new Ledger(f.engine), call = (name: string, body: Record<string, unknown>) => run(f.engine.call(l + name, body, ctx));
  const book = await call('LedgerBook.create', { key: 'ledger' }), debit = await call('Account.create', { book: book.id, key: 'expense', unit: 'USD' }), credit = await call('Account.create', { book: book.id, key: 'cash', unit: 'USD' });
  const input = { book: String(book.id), key: 'cost', policy: 'balanced' as const, reason: 'Exact cost', entries: [{ account: String(debit.id), quantity: '0.300001' }, { account: String(credit.id), quantity: '-0.300001' }] };
  const posting = await run(api.post(input, ctx)); expect(await run(new Ledger(f.engine).post(input, ctx))).toEqual(posting);
  await expect(run(api.post({ ...input, key: 'bad', entries: [{ account: String(debit.id), quantity: '0.300002' }, { account: String(credit.id), quantity: '-0.300001' }] }, ctx))).rejects.toThrow();
  const before = await run(api.rebuild(String(book.id), ctx)); expect(before.groupIds).toEqual([posting.id]); expect(before.balances[String(debit.id)]).toBe('0.300001'); expect(before.balances[String(credit.id)]).toBe('-0.300001');
  await run(api.reverse(String(book.id), String(posting.id), 'undo', 'Correction', ctx));
  const after = await run(api.rebuild(String(book.id), ctx)); expect(after.groupIds).toHaveLength(2);
  expect(after.balances[String(debit.id)]).toBe('0.000000'); expect(after.balances[String(credit.id)]).toBe('0.000000');
});
it('usage-retry-and-isolation', async () => {
  const ctx = context('usage'), api = new Usage(f.engine), call = (name: string, body: Record<string, unknown>) => run(f.engine.call(u + name, body, ctx));
  const dimension = await call('UsageDimension.create', { key: 'duration', unit: 'second' }), stream = await call('UsageStream.create', { label: 'Usage', dimension: dimension.id }), source = await call('UsageSource.create', { key: 'meter' });
  const input = { stream: String(stream.id), dimension: String(dimension.id), unit: 'second', quantity: '0.000001', ordinal: 1, source: String(source.id), eventKey: 'event', occurredAt: '2026-01-01T00:00:00Z' };
  const duplicates = await Promise.all([run(api.ingest(input, ctx)), run(api.ingest(input, ctx))]); expect(duplicates[0].id).toBe(duplicates[1].id);
  await expect(run(api.ingest({ ...input, quantity: '0.000002' }, ctx))).rejects.toThrow();
  const aggregate = await run(api.aggregate(String(stream.id), '2025-12-31T00:00:00Z', '2026-01-02T00:00:00Z', ctx)); expect(aggregate.quantity).toBe('0.000001'); expect(aggregate.eventIds).toEqual([duplicates[0].id]);
  await expect(run(api.aggregate(String(stream.id), '2025-12-31T00:00:00Z', '2026-01-02T00:00:00Z', { ...ctx, tenant: ctx.tenant + '-foreign' }))).rejects.toThrow();
});
it('terminal-absence-guard-race', async () => {
  const ctx = context('absence');
  const mutation = (key: string) => ({ operation: p + 'Publication.create', input: { key } });
  const absent = (key: string) => ({ absent: [{ resource: p + 'Publication', unique: 'key', values: { key } }] });
  await run(f.engine.call(p + 'Publication.create', { key: 'terminal' }, ctx));
  await expect(run(f.engine.atomic([mutation('must-not-publish')], ctx, absent('terminal')))).rejects.toMatchObject({ code: 'VersionConflict' });
  expect((await run(f.engine.call(p + 'Publication.create', { key: 'must-not-publish' }, ctx))).id).toBeTruthy();
  const race = await Promise.allSettled([
    run(f.engine.atomic([mutation('left')], ctx, absent('right'))),
    run(f.engine.atomic([mutation('right')], ctx, absent('left'))),
  ]);
  expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(race.filter(result => result.status === 'rejected')).toHaveLength(1);
  const loser = race[0]!.status === 'rejected' ? 'left' : 'right';
  // Failed transaction did not leave its publication or unique claim behind.
  expect((await run(f.engine.call(p + 'Publication.create', { key: loser }, ctx))).id).toBeTruthy();
  await run(f.engine.atomic([mutation('other-tenant')], { ...ctx, tenant: ctx.tenant + '-foreign' }, absent('terminal')));
});
