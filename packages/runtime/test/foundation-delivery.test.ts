import {Effect} from 'effect';
import {expect,it} from 'vitest';
import {foundation, foundationAdapters} from './helpers/foundation.js';
import {Deliveries} from '../src/foundation/delivery.js';
import {Artifacts} from '../src/foundation/artifact.js';
import {Evidence} from '../src/foundation/evidence.js';
import {localAuthorizer} from '../src/gatekeeper.js';
const p='@forgegraph/foundation/delivery/_/',a='@forgegraph/foundation/artifact/_/',e='@forgegraph/foundation/evidence/_/',d='@fixture/delivery-consumer/_/';
const start='2026-01-01T00:00:00Z',later='2026-01-01T01:00:00Z';
for(const adapter of foundationAdapters){
 it(`${adapter}: typed email/webhook/export intents pin payload and idempotently claim durable attempts`,async()=>{
  const f=await foundation('delivery',adapter,true);const {call,ctx,engine}=f;
  try{
   const service=new Deliveries(engine);
   const artifact=await call(a+'Artifact.create',{key:'payload',label:'Payload'}),content=await call(a+'ArtifactContent.create',{});
   const upload=await call(a+'ArtifactContent.beginUpload',{id:content.id,expectedVersion:1,mediaType:'text/plain',byteCount:5});
   await f.objects.simulateUpload((upload.upload as {url:string}).url,new TextEncoder().encode('proof'),'text/plain');
   const ready=await call(a+'ArtifactContent.finalizeUpload',{id:content.id,expectedVersion:2});
   const revision=await Effect.runPromise(new Artifacts(engine).publish({artifact:String(artifact.id),content:String(content.id),digest:String(ready.digest)},ctx));
   for(const [name,field,value,body,detail]of [['Email','address','a@example.test','EmailContent',{subject:'Notice',body:'Typed text'}],['Webhook','url','https://example.test/hook','WebhookContent',{eventKey:'published'}],['FileExport','location','s3://test/export','FileExport',{filename:'report.txt'}]]as const){
    const destination=await call(p+'DeliveryDestination.create',{key:name,label:name});
    await call(d+name+'Destination.create',{destination:destination.id,[field]:value});
    const input={key:name,destination:String(destination.id),payload:String(revision.id),maxAttempts:2};
    const intent=await Effect.runPromise(service.create(input,{...ctx,idempotencyKey:name}));
    expect(await Effect.runPromise(service.create(input,{...ctx,idempotencyKey:name}))).toEqual(intent);
    await expect(Effect.runPromise(service.create({...input,maxAttempts:3},{...ctx,idempotencyKey:name}))).rejects.toThrow();
    await call(d+body+'.create',{intent:intent.id,...detail});
    const claims=await Promise.allSettled(Array.from({length:6},()=>Effect.runPromise(service.claim(String(intent.id),'Send','Initial attempt',ctx))));
    expect(claims.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    const step=(claims.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Record<string,unknown>>).value;
    expect(await Effect.runPromise(service.outcome(String(step.id),ctx))).toBe('Claimed');
    const attempt=await Effect.runPromise(service.start(String(step.id),start,'test-provider',name+'-provider-key',ctx));
    await expect(Effect.runPromise(service.start(String(step.id),start,'test-provider','second',ctx))).rejects.toThrow();
    expect(await Effect.runPromise(service.outcome(String(step.id),ctx))).toBe('Started');
    const receipt={step:String(step.id),attempt:String(attempt.id),outcome:'Succeeded' as const,completedAt:later,providerReference:'provider-ref',callbackKey:name+'-callback',detail:'Acknowledged'};
    const received=await Effect.runPromise(service.receipt(receipt,{...ctx,idempotencyKey:name+'-receipt'}));
    expect(await Effect.runPromise(service.receipt(receipt,{...ctx,idempotencyKey:name+'-receipt'}))).toEqual(received);
    await expect(Effect.runPromise(service.receipt({...receipt,outcome:'Failed',callbackKey:name+'-late'},ctx))).rejects.toThrow();
    expect(await Effect.runPromise(service.outcome(String(step.id),ctx))).toBe('Succeeded');
    await expect(Effect.runPromise(service.claim(String(intent.id),'Send','No retry success',ctx,String(step.id)))).rejects.toThrow();
    expect(intent.payload).toBe(revision.id);
   }
  }finally{await f.close();}
 });
 it(`${adapter}: uncertain effects block retries until reconciliation; cancellation and retry claim one next slot`,async()=>{
  const f=await foundation('delivery',adapter,true);const {call,ctx,engine}=f;
  try{
   const service=new Deliveries(engine),destination=await call(p+'DeliveryDestination.create',{key:'partner',label:'Partner'});
   const intent=await Effect.runPromise(service.create({key:'uncertain',destination:String(destination.id),maxAttempts:2},ctx));
   const first=await Effect.runPromise(service.claim(String(intent.id),'Send','Send',ctx));
   const attempt=await Effect.runPromise(service.start(String(first.id),start,'provider','stable-provider-key',ctx));
   await expect(Effect.runPromise(service.claim(String(intent.id),'Cancel','In-flight cancellation refused',ctx,String(first.id)))).rejects.toThrow();
   const bundle=await call(e+'EvidenceBundle.create',{key:'receipt-proof',label:'Receipt proof'}),seal=await Effect.runPromise(new Evidence(engine).seal(String(bundle.id),null,ctx));
   const receipt=await Effect.runPromise(service.receipt({step:String(first.id),attempt:String(attempt.id),outcome:'Uncertain',completedAt:later,providerReference:'timeout',callbackKey:'ambiguous',detail:'Provider may have accepted before timeout',support:String(seal.id)},ctx));
   expect(await Effect.runPromise(service.outcome(String(first.id),ctx))).toBe('Uncertain');
   expect(await Effect.runPromise(new Deliveries(engine).outcome(String(first.id),ctx))).toBe('Uncertain');
   await expect(call(p+'DeliveryStep.create',{intent:intent.id,number:2,choice:'Send',previous:first.id,receipt:receipt.id,reason:'Raw ambiguous retry'})).rejects.toThrow();
   await expect(call(p+'DeliveryResolution.create',{receipt:receipt.id,outcome:'Uncertain',resolvedAt:later,detail:'Not a resolution'})).rejects.toThrow();
   await expect(Effect.runPromise(service.claim(String(intent.id),'Send','Unsafe retry',ctx,String(first.id)))).rejects.toThrow();
   await Effect.runPromise(service.resolve(String(receipt.id),'Failed',later,'Provider confirms no accepted send',ctx,String(seal.id)));
   await expect(Effect.runPromise(service.resolve(String(receipt.id),'Succeeded',later,'Contradictory late callback',ctx))).rejects.toThrow();
   const next=await Promise.allSettled([Effect.runPromise(service.claim(String(intent.id),'Send','Retry',ctx,String(first.id))),Effect.runPromise(service.claim(String(intent.id),'Cancel','Cancellation',ctx,String(first.id)))]);
   expect(next.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   const retry=(next.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<Record<string,unknown>>).value;
   expect(retry.number).toBe(2);
   if(retry.choice==='Send'){
    const second=await Effect.runPromise(service.start(String(retry.id),later,'provider','retry-key',ctx));
    await Effect.runPromise(service.receipt({step:String(retry.id),attempt:String(second.id),outcome:'Failed',completedAt:later,providerReference:'rejected',callbackKey:'retry-failed',detail:'Definitive failure'},ctx));
    await expect(Effect.runPromise(service.claim(String(intent.id),'Send','Budget exhausted',ctx,String(retry.id)))).rejects.toThrow();
    expect((await Effect.runPromise(service.claim(String(intent.id),'Cancel','Stop',ctx,String(retry.id)))).choice).toBe('Cancel');
   }
   const cancelled=await Effect.runPromise(service.create({key:'cancel-before-send',destination:String(destination.id),maxAttempts:1},ctx));
   await expect(call(p+'DeliveryStep.create',{intent:cancelled.id,number:2,choice:'Send',previous:first.id,receipt:receipt.id,reason:'Wrong intent'})).rejects.toThrow();
   const cancel=await Effect.runPromise(service.claim(String(cancelled.id),'Cancel','Withdrawn',ctx));
   expect(await Effect.runPromise(service.outcome(String(cancel.id),ctx))).toBe('Cancelled');
   await expect(Effect.runPromise(service.start(String(cancel.id),start,'provider','no-send',ctx))).rejects.toThrow();
   await expect(Effect.runPromise(service.claim(String(cancelled.id),'Send','Too late',ctx))).rejects.toThrow();
   await expect(Effect.runPromise(service.create({key:'foreign',destination:String(destination.id),maxAttempts:1},{...ctx,tenant:'foreign'}))).rejects.toThrow();
   for(const [resource,id]of [['DeliveryIntent',intent.id],['DeliveryAttempt',attempt.id],['DeliveryReceipt',receipt.id]])await expect(call(p+resource+'.delete',{id})).rejects.toThrow();
   engine.gatekeeper.authorizer=localAuthorizer({policies:[{id:'steps',actions:[p+'DeliveryStep.*'],requires:[],where:[]},{id:'intent',actions:[p+'DeliveryIntent.*'],requires:[],where:[]}],pips:[],epoch:1,knownObligations:[]});
   await expect(Effect.runPromise(service.outcome(String(first.id),ctx))).rejects.toThrow();
  }finally{await f.close();}
 });
}
