import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteActionLedger} from '../src/sqlite-ledger.mjs';
import {DurableActionCenter} from '../src/durable-action-center.mjs';

const action = (patch={}) => ({tenant:'t1',subject:'s1',kind:'approval',label:'Review payment',status:'pending',revision:1,assignees:['a1'],actions:['decide'],...patch});
const args = (patch={}) => ({tenant:'t1',actor:'a1',source:'approvals',subject:'s1',revision:1,action:'decide',purpose:'approvals.decide',idempotencyKey:'req-1',...patch});
const mk = ({ledger,dispatch=async()=>({accepted:true,receiptId:'provider-1'}),reconcile=async()=>({confirmed:true,receiptId:'recovered'}),authorize=async({tenant,actor,purpose})=>tenant==='t1' && purpose!=='wrong' && (actor==='a1'||(actor==='ops'&&purpose==='action.reconcile'))}={}) => {
  const store = ledger ?? new SqliteActionLedger();
  return {store, center:new DurableActionCenter({producers:{approvals:{kinds:['approval'],purposes:{decide:'approvals.decide',respond:'approvals.respond'}}},ledger:store,authorize,dispatch,reconcile})};
};

test('SQLite ledger persists across shutdown/restart and owns full projection history', async () => {
  const dir=mkdtempSync(join(tmpdir(),'forge-actions-'));
  const filename=join(dir,'ledger.sqlite');
  try {
    let one=mk({ledger:new SqliteActionLedger({filename})});
    one.center.ingest('approvals','e1',action());
    assert.equal((await one.center.list({tenant:'t1',actor:'a1'})).length,1);
    const first=await one.center.invoke(args());
    assert.equal(first.state,'acknowledged');
    one.store.close();
    const two=mk({ledger:new SqliteActionLedger({filename})});
    assert.equal((await two.center.list({tenant:'t1',actor:'a1'})).length,1);
    assert.deepEqual(await two.center.invoke(args()),{state:'acknowledged',backendKey:first.backendKey,replay:true,receiptId:'provider-1'});
    two.center.ingest('approvals','e2',action({revision:2,status:'resolved',actions:[]}));
    assert.equal((await two.center.list({tenant:'t1',actor:'a1'})).length,0);
    two.store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('event IDs and payloads dedupe; conflicting event or source revision never writes', async () => {
  const {store,center}=mk();
  assert.equal(center.ingest('approvals','e1',action()).accepted,true);
  assert.equal(center.ingest('approvals','e1',action()).reason,'duplicate-event');
  assert.throws(()=>center.ingest('approvals','e1',action({label:'Hijacked'})),/conflicting event ID/);
  assert.throws(()=>center.ingest('approvals','e2',action({label:'Hijacked'})),/conflicting source revision/);
  assert.equal(center.ingest('approvals','e2',action({revision:2})).accepted,true);
  assert.equal(store.get('t1','approvals','s1').record.revision,2);
  store.close();
});

test('revision gaps are fenced until an authenticated snapshot repairs them',async()=>{
  const {store,center}=mk();
  center.ingest('approvals','e1',action());
  assert.equal(center.ingest('approvals','e4',action({revision:4})).reason,'gap');
  assert.equal((await center.list({tenant:'t1',actor:'a1'})).length,0);
  assert.equal(center.ingest('approvals','e5',action({revision:5})).reason,'resync-required');
  assert.equal((await center.list({tenant:'t1',actor:'a1'})).length,0);
  assert.equal(center.ingest('approvals','snapshot',action({revision:5,fullSnapshot:true})).reason,'resynchronized');
  assert.equal((await center.list({tenant:'t1',actor:'a1'})).length,1);
  store.close();
});

test('parallel submissions claim only one backend action with stable backend idempotency',async()=>{
  let calls=0;const receipts=[];
  const {store,center}=mk({dispatch:async x=>{calls++;receipts.push(x.idempotencyKey);await new Promise(r=>setTimeout(r,20));return {accepted:true,receiptId:'x'};}});
  center.ingest('approvals','e1',action());
  const responses=await Promise.all(Array.from({length:8},(_,i)=>center.invoke(args({idempotencyKey:`request-${i}`}))));
  assert.equal(calls,1);
  assert.equal(new Set(responses.map(x=>x.backendKey)).size,1);
  assert.equal(receipts.length,1);
  assert.ok(responses.some(x=>x.state==='in_progress'));
  const afterward=await center.invoke(args({idempotencyKey:'later'}));
  assert.equal(afterward.state,'acknowledged');
  assert.equal(calls,1);
  store.close();
});

test('timeout after provider effect is uncertain and recovery never re-dispatches',async()=>{
  let calls=0;const {store,center}=mk({dispatch:async()=>{calls++;throw new Error('timeout');}});
  center.ingest('approvals','e1',action());
  const first=await center.invoke(args());
  assert.equal(first.state,'uncertain');
  assert.equal((await center.invoke(args())).state,'uncertain');
  assert.equal(calls,1);
  assert.equal(store.listRecovery({tenant:'t1'}).length,1);
  await assert.rejects(()=>center.reconcileIntent({tenant:'t1',operator:'bad',backendKey:first.backendKey}),/not authorized/);
  assert.equal((await center.reconcileIntent({tenant:'t1',operator:'ops',backendKey:first.backendKey})).state,'acknowledged');
  assert.equal((await center.invoke(args())).state,'acknowledged');
  assert.equal(calls,1);
  store.close();
});

test('definitive provider rejection is not approval, transport uncertainty is not rejection',async()=>{
  const {store,center}=mk({dispatch:async()=>({accepted:false,definitive:true})});
  center.ingest('approvals','e1',action());
  assert.equal((await center.invoke(args())).state,'rejected');
  assert.equal((await center.list({tenant:'t1',actor:'a1'})).length,1);
  assert.equal((await center.invoke(args())).state,'rejected');
  store.close();
});

test('authorization and tenant boundaries are independently applied on reads and writes',async()=>{
  const {store,center}=mk();
  center.ingest('approvals','e1',action());
  await assert.rejects(()=>center.invoke(args({actor:'bob'})),/not available/);
  await assert.rejects(()=>center.invoke(args({tenant:'t2'})),/not available/);
  await assert.rejects(()=>center.invoke(args({purpose:'wrong'})),/not authorized/);
  assert.equal((await center.list({tenant:'t2',actor:'a1'})).length,0);
  assert.equal((await center.list({tenant:'t1',actor:'bob'})).length,0);
  await assert.rejects(()=>center.reconcileIntent({tenant:'t2',backendKey:'fake',operator:'ops'}),/not found/);
  store.close();
});

test('client idempotency key cannot be replayed with another business operation',async()=>{
  const {store,center}=mk();
  center.ingest('approvals','e1',action({actions:['decide','respond']}));
  await center.invoke(args());
  await assert.rejects(()=>center.invoke(args({action:'respond',purpose:'approvals.respond'})),/idempotency_conflict/);
  store.close();
});

test('failing event transaction does not retain inconsistent or conflicting revision',async()=>{
  const {store,center}=mk();
  center.ingest('approvals','e1',action());
  assert.throws(()=>center.ingest('approvals','e2',action({label:'altered'})),/conflicting source revision/);
  assert.equal(center.ingest('approvals','e2',action({revision:2})).accepted,true);
  store.close();
});

test('post-crash reserved command may resume once only with fresh source and policy checks',async()=>{
  let calls=0;
  const {store,center}=mk({dispatch:async()=>{calls++;return {accepted:true,receiptId:'restarted'};},authorize:async x=>x.tenant==='t1' && (x.actor==='a1'||(x.actor==='ops'&&x.purpose==='action.resume'))});
  center.ingest('approvals','e1',action());
  // Crash after durable intent reservation but before claim: no external call.
  const {intent}=store.reserveIntent(args());
  const a=await center.resumeReserved({tenant:'t1',backendKey:intent.backendKey,operator:'ops'});
  assert.equal(a.state,'acknowledged');assert.equal(calls,1);
  assert.equal((await center.resumeReserved({tenant:'t1',backendKey:intent.backendKey,operator:'ops'})).state,'acknowledged');
  assert.equal(calls,1);store.close();
});
test('resumption fails closed when source revision changes or operator lacks scope',async()=>{
  let calls=0;const {store,center}=mk({dispatch:async()=>{calls++;return {accepted:true,receiptId:'never'};},authorize:async x=>x.tenant==='t1' && (x.actor==='a1'||(x.actor==='ops'&&x.purpose==='action.resume'))});
  center.ingest('approvals','e1',action());const {intent}=store.reserveIntent(args());
  await assert.rejects(()=>center.resumeReserved({tenant:'t1',backendKey:intent.backendKey,operator:'outsider'}),/not authorized/);
  center.ingest('approvals','e2',action({revision:2,status:'resolved',actions:[]}));
  const res=await center.resumeReserved({tenant:'t1',backendKey:intent.backendKey,operator:'ops'});
  assert.equal(res.state,'superseded');assert.equal(res.blocked,'source-state-changed');assert.equal(calls,0);assert.equal(store.listRecovery({tenant:'t1'}).length,0);store.close();
});
test('unknown provider reconciliation of in-progress command becomes uncertain, never retry',async()=>{
  const {store,center}=mk({reconcile:async()=>({confirmed:false})});
  center.ingest('approvals','e1',action());const {intent}=store.reserveIntent(args());
  store.claimIntent(intent.backendKey);
  assert.equal((await center.reconcileIntent({tenant:'t1',backendKey:intent.backendKey,operator:'ops'})).state,'uncertain');
  assert.equal(store.getIntent(intent.backendKey).state,'uncertain');store.close();
});
