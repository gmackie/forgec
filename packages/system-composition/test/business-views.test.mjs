import test from 'node:test';
import assert from 'node:assert/strict';
import {CommitmentInspector} from '../src/commitment-view.mjs';
import {ExceptionInspector} from '../src/exception-view.mjs';
const common={tenant:'org-1',agreementRevision:'terms-v1',termsDigest:'sha256-abc',providerVerified:true};
function commitment(patch={}) {
  const values={
    authorize:async({actor})=>actor==='auditor',
    agreement:async()=>({tenant:'org-1',revision:'terms-v1',termsDigest:'sha256-abc',providerVerified:true,accepted:true}),
    duty:async()=>({...common}),
    fulfillment:async()=>({...common,status:'completed',evidenceDigest:'delivery-e1',evidenceSealed:true}),
    acceptance:async()=>({...common,outcome:'accepted',revision:'decision-v1',evidenceDigest:'delivery-e1',verifiedDecision:true}),
    settlement:async()=>({...common,status:'settled',acceptanceRevision:'decision-v1',settlementEvidenceSealed:true}),...patch,
  };return new CommitmentInspector(values);
}
const req={tenant:'org-1',actor:'auditor',commitmentId:'agreement-1'};
test('commitment requires actual fulfillment, evidence, distinct acceptance and settlement',async()=>{
  assert.equal((await commitment().inspect(req)).state,'settled');
  assert.equal((await commitment({fulfillment:async()=>({...common,status:'planned'})}).inspect(req)).state,'blocked'); // settlement claim cannot override incomplete work
  assert.equal((await commitment({acceptance:async()=>({...common,outcome:'pending'})}).inspect(req)).state,'blocked');
  assert.equal((await commitment({settlement:async()=>({...common,status:'unsettled'})}).inspect(req)).state,'awaiting-settlement');
});
test('commitment rejects stale terms, denied actor and modified terms during read',async()=>{
  await assert.rejects(()=>commitment().inspect({...req,actor:'viewer'}),/not authorized/);
  await assert.rejects(()=>commitment({fulfillment:async()=>({...common,agreementRevision:'old',status:'completed'})}).inspect(req),/stale terms/);
  let n=0;const x=commitment({agreement:async()=>{n++;return {tenant:'org-1',providerVerified:true,revision:n===1?'terms-v1':'terms-v2',termsDigest:'sha256-abc',accepted:true};}});
  const outcome=await x.inspect(req);assert.equal(outcome.state,'blocked');assert.ok(outcome.blockers.includes('terms-changed-during-review'));
});
const fact={tenant:'org-1',desiredRevision:'desired-1',providerVerified:true};
function exception(patch={}) {
  return new ExceptionInspector({
    authorize:async({actor})=>actor==='auditor',
    desired:async()=>({tenant:'org-1',revision:'desired-1',providerVerified:true}),
    observations:async()=>({...fact,converged:false,evidenceSealed:true}),
    investigation:async()=>({...fact,state:'open'}),
    correction:async()=>({...fact,key:'corr-1',state:'completed'}),
    reobserve:async()=>({...fact,correctionKey:'corr-1',converged:true,evidenceSealed:true,observedAfterCorrection:true}),...patch,
  });
}
const ex={tenant:'org-1',actor:'auditor',scopeId:'erp-refund-1'};
test('exception requires fresh observed convergence after correction',async()=>{
  assert.equal((await exception().inspect(ex)).state,'converged');
  assert.equal((await exception({reobserve:async()=>({...fact,converged:true,evidenceSealed:true,observedAfterCorrection:false,correctionKey:'corr-1'})}).inspect(ex)).state,'awaiting-verification');
  assert.equal((await exception({correction:async()=>({...fact,state:'uncertain'})}).inspect(ex)).state,'uncertain');
  assert.equal((await exception({investigation:async()=>({...fact,state:'closed'})}).inspect(ex)).state,'converged');
  assert.equal((await exception({investigation:async()=>({...fact,state:'closed'}),reobserve:async()=>null}).inspect(ex)).state,'blocked');
});
test('exception rejects different desired revisions, unauthorized reads, and re-observation mismatch',async()=>{
  await assert.rejects(()=>exception().inspect({...ex,actor:'viewer'}),/not authorized/);
  await assert.rejects(()=>exception({correction:async()=>({...fact,desiredRevision:'old',state:'completed'})}).inspect(ex),/mismatched observation/);
  let n=0;const x=exception({desired:async()=>({tenant:'org-1',providerVerified:true,revision:++n===1?'desired-1':'desired-2'})});
  assert.equal((await x.inspect(ex)).state,'blocked');
});

test('non-SDLC commitment and exception pilots expose separate typed MCP tools over one gateway',async()=>{
  const {readFileSync}=await import('node:fs');
  const {SqliteActionLedger}=await import('../src/sqlite-ledger.mjs');
  const {SystemGateway,mcpDescriptors,callMcpTool}=await import('../src/system-gateway.mjs');
  const catalog=JSON.parse(readFileSync(new URL('../catalog/systems.json',import.meta.url)));
  const ledger=new SqliteActionLedger();
  const requestSchema=field=>({type:'object',properties:{[field]:{type:'string'}},required:[field],additionalProperties:false});
  const exact=field=>input=>{
    if(!input||Object.keys(input).length!==1||typeof input[field]!=='string'||!input[field])throw new TypeError('invalid business reference');
    return {[field]:input[field]};
  };
  const obligations=commitment();
  const discrepancies=exception();
  const principal={verified:true,tenant:'org-1',actor:'auditor'};
  const gateway=new SystemGateway({catalog,ledger,authorize:async x=>x.principal.verified===true&&x.tenant==='org-1'&&x.actor==='auditor',bindings:{
    'commitments/list-obligations':{
      owner:'agreement-catalog',inputSchema:requestSchema('commitmentId'),validate:exact('commitmentId'),
      execute:async({context,input})=>obligations.inspect({tenant:context.tenant,actor:context.actor,commitmentId:input.commitmentId}),project:x=>x,
    },
    'exception-operations/detect-discrepancy':{
      owner:'reconciliation',inputSchema:requestSchema('scopeId'),validate:exact('scopeId'),
      execute:async({context,input})=>discrepancies.inspect({tenant:context.tenant,actor:context.actor,scopeId:input.scopeId}),project:x=>x,
    },
  }});
  const tools=mcpDescriptors(gateway);
  assert.equal(tools.length,2);
  const a=await callMcpTool({gateway,descriptors:tools,principal,toolName:'forge_commitments__list_obligations',arguments:{commitmentId:'agreement-1'}});
  assert.equal(a.data.state,'settled');
  const b=await callMcpTool({gateway,descriptors:tools,principal,toolName:'forge_exception_operations__detect_discrepancy',arguments:{scopeId:'erp-refund-1'}});
  assert.equal(b.data.state,'converged');
  await assert.rejects(()=>callMcpTool({gateway,descriptors:tools,principal:{...principal,actor:'bob'},toolName:'forge_commitments__list_obligations',arguments:{commitmentId:'agreement-1'}}),/not authorized/);
  ledger.close();
});
