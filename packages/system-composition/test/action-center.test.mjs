import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionCenter } from '../src/action-center.mjs';
const event = (patch = {}) => ({ tenant: 'org-1', subject: 'req-1', kind: 'approval', label: 'Review contract', status: 'pending', revision: 1, assignees: ['alice'], actions: ['decide'], ...patch });
function fixture() {
  const dispatched = [];
  const center = new ActionCenter({
    producers: { approvals: { kinds: ['approval'] } },
    authorize: async ({ actor, tenant, purpose }) => actor === 'alice' && tenant === 'org-1' && purpose !== 'wrong',
    dispatch: async call => { dispatched.push(call); return { upstreamId: 'receipt-1' }; },
  });
  return { center, dispatched };
}

test('trusted producer can publish, duplicate has no effect, same revision with different content conflicts', () => {
  const {center} = fixture();
  assert.equal(center.ingest('approvals', event()).accepted, true);
  assert.deepEqual(center.ingest('approvals', event()).reason, 'duplicate');
  assert.throws(() => center.ingest('approvals', event({label: 'Different'})), /conflicting source revision/);
  assert.throws(() => center.ingest('untrusted', event()), /unknown trusted producer/);
  assert.throws(() => center.ingest('approvals', event({kind:'case'})), /does not own/);
});
test('only assigned and authorized users can see action metadata; tenant isolated', async () => {
  const {center} = fixture(); center.ingest('approvals', event());
  assert.equal((await center.list({tenant:'org-1', actor:'alice'})).length, 1);
  assert.equal((await center.list({tenant:'org-1', actor:'bob'})).length, 0);
  assert.equal((await center.list({tenant:'org-2', actor:'alice'})).length, 0);
  assert.equal((await center.list({tenant:'org-1', actor:'alice',purpose:'wrong'})).length, 0);
});
test('stale updates are ignored and missing revisions suspend action until authoritative resync', async () => {
  const {center} = fixture(); center.ingest('approvals', event());
  assert.equal(center.ingest('approvals', event({revision:3})).reason, 'gap');
  assert.equal((await center.list({tenant:'org-1', actor:'alice'})).length, 0);
  assert.equal(center.ingest('approvals', event({revision:4})).reason, 'resync-required');
  assert.equal(center.ingest('approvals', event({revision:4, fullSnapshot:true})).accepted, true);
  assert.equal((await center.list({tenant:'org-1', actor:'alice'})).length, 1);
  assert.equal(center.ingest('approvals', event({revision:2})).reason, 'stale');
});
test('invocation requires revision, actor, explicit authorization and idempotency key; does not auto-resolve', async () => {
  const {center, dispatched} = fixture(); center.ingest('approvals', event());
  await assert.rejects(() => center.invoke({tenant:'org-1',actor:'bob',source:'approvals',subject:'req-1',revision:1,action:'decide',purpose:'approvals.decide',idempotencyKey:'123'}), /not available/);
  await assert.rejects(() => center.invoke({tenant:'org-1',actor:'alice',source:'approvals',subject:'req-1',revision:0,action:'decide',purpose:'approvals.decide',idempotencyKey:'123'}), /stale action/);
  await assert.rejects(() => center.invoke({tenant:'org-1',actor:'alice',source:'approvals',subject:'req-1',revision:1,action:'decide',purpose:'wrong',idempotencyKey:'123'}), /not authorized/);
  const result = await center.invoke({tenant:'org-1',actor:'alice',source:'approvals',subject:'req-1',revision:1,action:'decide',purpose:'approvals.decide',idempotencyKey:'123'});
  assert.equal(result.state, 'submitted');
  assert.equal(dispatched.length, 1);
  assert.equal((await center.list({tenant:'org-1',actor:'alice'})).length, 1);
  center.ingest('approvals', event({revision:2,status:'resolved',actions:[]}));
  assert.equal((await center.list({tenant:'org-1',actor:'alice'})).length, 0);
});
test('forbids malformed input and early mutation', async () => {
  const {center} = fixture();
  assert.throws(() => center.ingest('approvals', event({revision:0})), /revision/);
  assert.throws(() => center.ingest('approvals', event({assignees:['alice','alice']})), /assignees/);
  assert.throws(() => center.ingest('approvals', event({status:'pending',actions:[]})), /available command/);
  await assert.rejects(() => center.invoke({tenant:'org-1',actor:'alice',source:'approvals',subject:'req-1',revision:1,action:'decide',purpose:'approvals.decide',idempotencyKey:''}), /idempotency/);
});
test('same-revision full snapshot may unblock a fenced gap', async () => {
  const {center} = fixture(); center.ingest('approvals', event());
  center.ingest('approvals', event({revision:4}));
  const res = center.ingest('approvals', event({revision:4,fullSnapshot:true}));
  assert.equal(res.reason,'resynchronized');
  assert.equal((await center.list({tenant:'org-1',actor:'alice'})).length,1);
});
