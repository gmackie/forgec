import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SqliteActionLedger} from '../src/sqlite-ledger.mjs';
import {SystemGateway,mcpDescriptors,callMcpTool} from '../src/system-gateway.mjs';
const catalog=JSON.parse(readFileSync(new URL('../catalog/systems.json',import.meta.url)));
const principal={tenant:'t1',actor:'alice',verified:true};
const empty={type:'object',properties:{},additionalProperties:false};
const approval={type:'object',properties:{caseId:{type:'string'},revision:{type:'integer'},option:{type:'string'}},required:['caseId','revision','option'],additionalProperties:false};
function create({authorize=async()=>true,execute=async({input})=>({accepted:true,receiptId:`case-${input.caseId}`})}={}) {
  const ledger=new SqliteActionLedger();let dispatches=0;
  const gateway=new SystemGateway({catalog,authorize,ledger,bindings:{
    'action-center/list-pending':{
      owner:'routing',inputSchema:empty,validate:async v=>{if(Object.keys(v??{}).length)throw Error('extra field');return {};},
      execute:async()=>[{id:'action-1'}],project:async x=>x,
    },
    'change-intelligence/review-approval':{
      owner:'approvals',inputSchema:approval,
      validate:async v=>{if(!v||typeof v.caseId!=='string'||!v.caseId||!Number.isSafeInteger(v.revision)||typeof v.option!=='string'||!['approve','reject'].includes(v.option)||Object.keys(v).some(x=>!['caseId','revision','option'].includes(x)))throw TypeError('invalid approval input');return {...v};},
      logicalKey: v=>v.caseId,revision:v=>v.revision,
      execute:async x=>{dispatches++;return execute(x);},project:async x=>x,
    }
  }});
  return {gateway,ledger,calls:()=>dispatches};
}
test('exact catalog ownership, closed schemas and trusted principal required',async()=>{
  const {gateway,ledger}=create();
  await assert.rejects(()=>gateway.invoke({principal:{...principal,verified:false},systemId:'action-center',operationId:'list-pending',input:{}}),/unauthenticated/);
  await assert.rejects(()=>gateway.invoke({principal,systemId:'action-center',operationId:'list-pending',input:{evil:true}}),/extra field/);
  await assert.rejects(()=>gateway.invoke({principal,systemId:'unknown',operationId:'anything',input:{}}),/not installed/);
  assert.throws(()=>new SystemGateway({catalog,ledger,authorize:async()=>true,bindings:{'action-center/list-pending':{owner:'change',inputSchema:empty,validate:async()=>({}),execute:async()=>{},project:async()=>{}}}}),/unauthorized trusted binding/);
  ledger.close();
});
test('mcp descriptors only expose explicitly bound tools, never unbound catalog claims',async()=>{
  const {gateway,ledger}=create();const tools=mcpDescriptors(gateway);
  assert.equal(tools.length,2);assert.ok(tools.some(t=>t.name==='forge_change_intelligence__review_approval'));
  const result=await callMcpTool({gateway,descriptors:tools,principal,toolName:'forge_action_center__list_pending',arguments:{}});
  assert.deepEqual(result,{state:'queried',data:[{id:'action-1'}]});
  ledger.close();
});
test('commands are always bound to request terms + actor and backend idempotency',async()=>{
  const {gateway,ledger,calls}=create();const input={caseId:'a1',revision:1,option:'approve'};
  const x=await gateway.invoke({principal,systemId:'change-intelligence',operationId:'review-approval',input,idempotencyKey:'key-1'});
  assert.equal(x.state,'acknowledged');assert.equal(calls(),1);
  const replay=await gateway.invoke({principal,systemId:'change-intelligence',operationId:'review-approval',input,idempotencyKey:'new-key'});
  assert.equal(replay.replay,true);assert.equal(calls(),1);
  await assert.rejects(()=>gateway.invoke({principal,systemId:'change-intelligence',operationId:'review-approval',input:{...input,option:'reject'},idempotencyKey:'newer-key'}),/operation_conflict/);
  ledger.close();
});
test('one client key cannot execute another command and transport failure remains uncertain',async()=>{
  const {gateway,ledger}=create({execute:async()=>{throw Error('network disconnected after dispatch');}});
  const input={caseId:'a1',revision:1,option:'approve'};
  assert.equal((await gateway.invoke({principal,systemId:'change-intelligence',operationId:'review-approval',input,idempotencyKey:'key-1'})).state,'uncertain');
  await assert.rejects(()=>gateway.invoke({principal,systemId:'change-intelligence',operationId:'review-approval',input:{...input,caseId:'a2'},idempotencyKey:'key-1'}),/idempotency_conflict/);
  ledger.close();
});
test('all system operations are namespace-checked and authorization is per purpose',async()=>{
  const {gateway,ledger}=create({authorize:async x=>x.purpose==='work.read'});
  await assert.rejects(()=>gateway.invoke({principal,systemId:'change-intelligence',operationId:'review-approval',input:{caseId:'x',revision:1,option:'approve'},idempotencyKey:'1'}),/not authorized/);
  assert.equal((await gateway.invoke({principal,systemId:'action-center',operationId:'list-pending',input:{}})).state,'queried');
  ledger.close();
});
