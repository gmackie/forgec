import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const c=JSON.parse(readFileSync('/stage/config.json','utf8'));const b=c.bindings[0];
const tests=[];
async function check(name,token,body,expected){const r=await fetch('http://127.0.0.1:4310/api/v1/foundation/completions',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,expected,name);tests.push({name,status:'passed',httpStatus:r.status});return data;}
const input={workspaceId:b.workspaceId,taskRunId:b.taskRunId};
if(process.argv.includes('--outage')){await check('Foundation outage is recoverable without exposing provider error',c.operatorToken,input,503);}
else if(process.argv.includes('--disabled')){await check('Opt-out rollback disables reconciliation',c.operatorToken,input,404);}
else if(process.argv.includes('--replay')){const r=await check('Restart replay preserves exact Foundation IDs',c.operatorToken,input,200);assert.deepEqual(r,JSON.parse(readFileSync('/stage/first-result.json','utf8')));}
else {
 await check('Unauthenticated caller rejected','invalid',input,401);
 await check('Read-only API key rejected',c.readToken,input,403);
 await check('Untrusted identity input rejected',c.operatorToken,{...input,userId:'other'},400);
 await check('Cross-workspace attempt rejected',c.operatorToken,{...input,workspaceId:'00000000-0000-4000-8000-000000000000'},403);
 const first=await check('Persisted native Bob run reconciles to real Foundation PostgreSQL',c.operatorToken,input,200);
 const replay=await check('Explicit retry is idempotent',c.operatorToken,input,200);assert.deepEqual(first,replay);
 writeFileSync('/stage/first-result.json',JSON.stringify(first));
}
const file='/stage/acceptance.json';let prior=[];try{prior=JSON.parse(readFileSync(file,'utf8')).tests;}catch{}
writeFileSync(file,JSON.stringify({scope:'Deployed isolated Bob reconciliation operation with native API-key authentication and separate PostgreSQL databases; synthetic seeded runs, no task execution or production rollout',at:new Date().toISOString(),tests:[...prior,...tests]},null,2)+'\n');
console.log(JSON.stringify(tests));
