import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConnector, decodeSettings} from './connector.mjs';
const scope={tenant:'certification',account:'test-account',script:'disposable'};
const ctx={tenant:'certification'};
function harness(overrides={}) {
 const journal=new Map();let writes=0,reads=0;let tags=[];
 const options={...scope,credential:async()=> 'secret',journal:{create:async(k,v)=>{if(journal.has(k))return false;journal.set(k,v);return true;},read:async k=>journal.get(k),write:async(k,v)=>journal.set(k,v)},transport:async(method,input)=>{if(method==='PATCH'){writes++;tags=input.tags;return {tags};}reads++;return {tags};},...overrides};
 return {options,journal,stats:()=>({writes,reads})};
}
test('strict settings decoding preserves absence and null without scalar coercion',()=>{
 assert.deepEqual(decodeSettings({}),{});assert.deepEqual(decodeSettings({tags:null,logpush:false}),{tags:null,logpush:false});
 for(const x of [{tags:[3]},{logpush:'false'},null,[],{tags:false}])assert.throws(()=>decodeSettings(x));
});
test('scope and input checks run before credentials or traffic',async()=>{
 const h=harness({credential:()=>{throw new Error('credential should not be read');}}),c=createConnector(h.options);
 assert.equal((await c.read({}, {tenant:'foreign'})).code,'ConnectionScopeMismatch');
 assert.equal((await c.mark({key:'x',tag:23},ctx)).code,'ExternalInputInvalid');
 assert.equal((await c.read({account:'foreign'},ctx)).code,'ExternalInputInvalid');
 assert.equal((await c.mark({key:'x',tag:'release:x',account:'foreign'},ctx)).code,'ExternalInputInvalid');
 assert.deepEqual(h.stats(),{writes:0,reads:0});
});
test('uncertain write survives restart, reconciles by read, and never duplicates writes',async()=>{
 const h=harness();const transport=h.options.transport;h.options.transport=async(...args)=>{const v=await transport(...args);if(args[0]==='PATCH')throw new Error('secret response lost');return v;};
 assert.equal((await createConnector(h.options).mark({key:'release-1',tag:'release:1'},ctx)).code,'ExternalOutcomeUnknown');
 assert.equal(h.journal.get('release-1').status,'uncertain');
 const restarted=createConnector(h.options);assert.deepEqual(await restarted.mark({key:'release-1',tag:'release:1'},ctx),{ok:true,value:{tag:'release:1',reconciled:true}});
 assert.equal(h.stats().writes,1);
 assert.equal((await restarted.mark({key:'release-1',tag:'release:2'},ctx)).code,'IdempotencyMismatch');
});
test('cancellation is bounded and failures never expose vendor/token details',async()=>{
 const h=harness({transport:async()=>{throw Object.assign(new Error('token-secret'),{statusCode:401});}}),c=createConnector(h.options);
 assert.deepEqual(await c.read({},ctx),{ok:false,code:'ExternalCredentialsRejected'});
 const controller=new AbortController();controller.abort();assert.equal((await c.read({},ctx,controller.signal)).code,'ExternalCancelled');
});
test('pagination/envelope changes and unrecognized response fields fail closed',()=>{
 for(const value of [{result:[{tags:[]}],result_info:{page:1}},{tags:[],next:'cursor'},{tags:[],logpush:1}])assert.throws(()=>decodeSettings(value));
});
