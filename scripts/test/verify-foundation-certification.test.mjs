import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { profiles } from '../verify-foundation-providers.mjs';
import { validateCertificationReceipt, validateCertificationMatrix } from '../verify-foundation-certification.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(slug='allocation',provider='postgres') {
 const fingerprint=hash('source'),harnessSha256=hash('harness'),artifacts=['app.json','d1/0001_init.sql','postgres/0001_init.sql'].map(path=>({path,sha256:hash(path)}));
 const report=Buffer.from(JSON.stringify({success:true,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{assertionResults:profiles[slug].requiredTraces.map(title=>({title,status:'passed'}))}]}));
 const runId='11111111-1111-1111-1111-111111111111';
 const observed=provider==='postgres'?{driver:'pg',serverVersion:'17.0'}:provider==='dynamodb'?{service:'aws-dynamodb',region:'us-east-1',tableStatus:'ACTIVE',tableArnHash:hash('arn')}:{protocol:'foundation-d1/1',provider:'cloudflare-d1-hosted',bundleSha256:artifacts[0].sha256,harnessSha256,colo:'DTW'};
 const receipt={version:1,suite:'providers',status:'passing',profile:`foundation-${slug}-invariants/1`,provider,sourceFingerprint:fingerprint,artifacts,coverageCriteria:profiles[slug].criteria,requestedTraces:profiles[slug].requiredTraces,passedTraces:profiles[slug].requiredTraces,testReportSha256:hash(report),runId,verifiedAt:new Date().toISOString(),targetHash:hash('target'),topology:{postgres:'native-postgres-local',d1:'cloudflare-d1-hosted',dynamodb:'aws-dynamodb-hosted'}[provider],identity:{provider,runId,tenantPrefix:`foundation-cert-${runId}`,objectStore:'memory object-store test double; database durability only',observed}};
 return {receipt,report,expected:{slug,provider,fingerprint,artifacts,harnessSha256}};
}
test('all exact current provider cells are required',()=>{
 const cells=Object.keys(profiles).flatMap(slug=>['postgres','d1','dynamodb'].map(provider=>{const f=fixture(slug,provider);return validateCertificationReceipt(f.receipt,f.report,f.expected);}));
 assert.equal(validateCertificationMatrix(cells).length,Object.keys(profiles).length*3);
 assert.throws(()=>validateCertificationMatrix(cells.slice(1)),/exactly every/);
 assert.throws(()=>validateCertificationMatrix([...cells.slice(1),cells[1]]),/exactly every/);
 assert.throws(()=>validateCertificationMatrix(cells.map((c,i)=>i===0?{...c,sourceFingerprint:hash('different')}:c)),/identical source/);
});
test('stale source, altered artifacts, wrong criteria and raw test tampering fail closed',()=>{
 const f=fixture();
 for(const patch of [{sourceFingerprint:hash('stale')},{artifacts:[]},{coverageCriteria:['F50-STORE']},{requestedTraces:[]},{passedTraces:[]},{testReportSha256:hash('tampered')},{status:'running'}])assert.throws(()=>validateCertificationReceipt({...f.receipt,...patch},f.report,f.expected));
 const report=Buffer.from(JSON.stringify({success:true,numFailedTests:0,numPendingTests:1,numTodoTests:0,testResults:[{assertionResults:profiles.allocation.requiredTraces.map(title=>({title,status:'pending'}))}]}));
 assert.throws(()=>validateCertificationReceipt({...f.receipt,testReportSha256:hash(report)},report,f.expected),/every required trace/);
});
test('provider identity cannot claim local emulation or a different deployment',()=>{
 for(const provider of ['postgres','d1','dynamodb']){
  const f=fixture('ledger',provider);
  assert.throws(()=>validateCertificationReceipt({...f.receipt,topology:'local-emulator'},f.report,f.expected));
  assert.throws(()=>validateCertificationReceipt({...f.receipt,identity:{...f.receipt.identity,runId:'other'}},f.report,f.expected));
 }
 const f=fixture('decision','d1');
 assert.throws(()=>validateCertificationReceipt({...f.receipt,identity:{...f.receipt.identity,observed:{...f.receipt.identity.observed,bundleSha256:hash('other')}}},f.report,f.expected),/deployment/);
});
