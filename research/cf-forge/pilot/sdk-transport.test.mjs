import {test} from 'node:test';import assert from 'node:assert/strict';
import {sdkTransport} from './sdk-transport.mjs';import {createConnector} from './connector.mjs';
import map from '../.cache/pilot-sdk/sdk/sdk-map.json' with {type:'json'};
const ctx={tenant:'t'},options={tenant:'t',account:'account',script:'worker',credential:async()=> 'redacted'};
test('operation removal and request-map evolution reject at selection',()=>{
 assert.throws(()=>sdkTransport(fetch,undefined,{}));
 const changed=structuredClone(map);changed['worker-script-settings-patch-settings'].requestBodyProperty='settings';assert.throws(()=>sdkTransport(fetch,undefined,changed));
});
test('generated SDK owns serialization with one retry owner and redacted errors',async()=>{
 let calls=0;const transport=sdkTransport(async()=>{calls++;return Response.json({errors:[{message:'private vendor message'}]},{status:503});});
 assert.deepEqual(await createConnector({...options,transport}).read({},ctx),{ok:false,code:'ExternalUnavailable'});assert.equal(calls,1);
});
test('cancellation interrupts an in-flight generated SDK request',async()=>{
 let seen=false;const controller=new AbortController();
 const transport=sdkTransport(async(_,init)=>new Promise((_,reject)=>{seen=true;init.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});controller.abort();}));
 assert.deepEqual(await createConnector({...options,transport}).read({},ctx,controller.signal),{ok:false,code:'ExternalCancelled'});assert.equal(seen,true);
});
test('response/error/pagination drift is rejected without coercion',async()=>{
 for(const body of [{success:true,result:{tags:[42]}},{success:true,result:[],result_info:{page:1}},{success:false,errors:[{code:999,message:'private'}]}]) {
  const transport=sdkTransport(async()=>Response.json(body));const result=await createConnector({...options,transport}).read({},ctx);
  assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('private'));
 }
});
