import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangeControlCollector} from '../src/change-control.mjs';
const common={tenant:'tenant-1',changeId:'change-4',sourceRevision:'rev-1',planDigest:'plan-1',providerVerified:true};
const head=()=>({...common,verified:true,requiredChecks:['unit'],requiredEnvironments:['production'],approvalRequired:true,verificationRequired:true});
const fixture=(patch={})=>{
  let sourceReads=0;
  const ports={
    authorize:async({actor})=>actor==='alice',
    source:async()=>{sourceReads++;return head();},
    impacts:async()=>[{...common,subject:'function',status:'resolved'}],
    approvals:async()=>[{...common,verified:true,outcome:'approved',sequence:1}],
    checks:async()=>[{...common,name:'unit',verified:true,status:'pass',sequence:1}],
    deployments:async()=>[{...common,environment:'production',status:'active',sequence:1,observation:{status:'converged',verified:true,sourceRevision:'rev-1'}}],
    ...patch,
  };
  return {collector:new ChangeControlCollector(ports),getSourceReads:()=>sourceReads};
};
const request={tenant:'tenant-1',actor:'alice',changeId:'change-4'};
test('trusted head and evidence from distinct providers produce verified advisory verdict',async()=>{
  const f=fixture();const result=await f.collector.assess(request);
  assert.equal(result.verdict,'verified');assert.equal(result.authority,'advisory-projection');assert.equal(f.getSourceReads(),2);
});
test('no read permission prevents all downstream provider calls',async()=>{
  let calls=0;const f=fixture({impacts:async()=>{calls++;return [];}});
  await assert.rejects(()=>f.collector.assess({...request,actor:'bob'}),/not authorized/);assert.equal(calls,0);
});
test('provider facts cannot cross tenants or claim unverified evidence',async()=>{
  await assert.rejects(()=>fixture({checks:async()=>[{...common,tenant:'other',name:'unit',status:'pass',verified:true}]}).collector.assess(request),/mismatched tenant/);
  await assert.rejects(()=>fixture({approvals:async()=>[{...common,providerVerified:false,verified:true,outcome:'approved'}]}).collector.assess(request),/unverified/);
  await assert.rejects(()=>fixture({deployments:async()=>[{...common,planDigest:'old',environment:'production',status:'active'}]}).collector.assess(request),/mismatched source revision or plan/);
});
test('head mutation while assembling evidence blocks instead of authorizing old approval',async()=>{
  let i=0;const f=fixture({source:async()=>{i++;return {...head(),sourceRevision:i===1?'rev-1':'rev-2'};}});
  assert.equal((await f.collector.assess(request)).verdict,'blocked');
});
test('plan mutation without source revision mutation also blocks',async()=>{
  let i=0;const f=fixture({source:async()=>{i++;return {...head(),planDigest:i===1?'plan-1':'plan-2'};}});
  const result=await f.collector.assess(request);
  assert.equal(result.verdict,'blocked');assert.ok(result.blockers.includes('plan-changed-during-assessment'));
});
test('provider failure never grants a ready verdict',async()=>{
  const f=fixture({approvals:async()=>{throw new Error('provider unavailable');}});
  await assert.rejects(()=>f.collector.assess(request),/provider unavailable/);
});
